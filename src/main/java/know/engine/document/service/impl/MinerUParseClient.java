package know.engine.document.service.impl;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.io.input.TeeInputStream;
import org.apache.hc.client5.http.classic.methods.HttpGet;
import org.apache.hc.client5.http.classic.methods.HttpPost;
import org.apache.hc.client5.http.classic.methods.HttpUriRequestBase;
import org.apache.hc.client5.http.config.RequestConfig;
import org.apache.hc.client5.http.entity.mime.MultipartEntityBuilder;
import org.apache.hc.client5.http.impl.classic.CloseableHttpClient;
import org.apache.hc.client5.http.impl.classic.HttpClients;
import org.apache.hc.core5.http.ContentType;
import org.apache.hc.core5.http.io.entity.ByteArrayEntity;
import org.apache.hc.core5.http.io.entity.EntityUtils;
import org.apache.hc.core5.util.Timeout;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/** Retains the legacy ZIP API and supports MinerU's asynchronous v1 API on HTTP 404. */
final class MinerUParseClient {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final String baseUrl;
    private final int connectTimeout;
    private final int responseTimeout;
    private final String tier;
    private final long pollIntervalMs;

    MinerUParseClient(String baseUrl, int connectTimeout, int responseTimeout, String tier) {
        this(baseUrl, connectTimeout, responseTimeout, tier, 1000);
    }

    MinerUParseClient(String baseUrl, int connectTimeout, int responseTimeout, String tier, long pollIntervalMs) {
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.connectTimeout = connectTimeout;
        this.responseTimeout = responseTimeout;
        this.tier = tier;
        this.pollIntervalMs = pollIntervalMs;
    }

    byte[] parseZip(String fileName, InputStream fileStream) throws IOException, InterruptedException {
        // Keep legacy uploads streaming; a disk copy allows replay only if the API is absent.
        var replayFile = Files.createTempFile("mineru-upload-", ".bin");
        try (fileStream; CloseableHttpClient client = HttpClients.createDefault();
             var replay = Files.newOutputStream(replayFile)) {
            HttpPost legacy = new HttpPost(baseUrl + "/file_parse");
            legacy.setHeader("Accept", "application/json");
            legacy.setEntity(MultipartEntityBuilder.create()
                    .setCharset(StandardCharsets.UTF_8)
                    .addBinaryBody("files", new TeeInputStream(fileStream, replay, false), ContentType.APPLICATION_OCTET_STREAM, fileName)
                    .addTextBody("backend", "pipeline")
                    .addTextBody("response_format_zip", "true")
                    .addTextBody("return_images", "true")
                    .addTextBody("return_model_output", "false")
                    .addTextBody("return_middle_json", "false").build());
            Payload legacyResult = execute(client, legacy, responseTimeout);
            if (legacyResult.status == 200) {
                return legacyResult.body;
            }
            if (legacyResult.status != 404) {
                throw failure("文件解析接口调用失败", legacyResult);
            }
            replay.flush();
            return parseV1(client, fileName, Files.readAllBytes(replayFile));
        } finally {
            Files.deleteIfExists(replayFile);
        }
    }

    private byte[] parseV1(CloseableHttpClient client, String fileName, byte[] fileBytes)
            throws IOException, InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(responseTimeout);
        HttpPost create = new HttpPost(baseUrl + "/v1/parse/jobs");
        create.setEntity(new ByteArrayEntity(JSON.writeValueAsBytes(Map.of(
                "files", List.of(Map.of("source", Map.of("type", "inline", "name", fileName,
                        "data", Base64.getEncoder().encodeToString(fileBytes)))),
                "tier", tier, "output_formats", List.of("zip"))), ContentType.APPLICATION_JSON));
        JsonNode job = readJson(execute(client, create, remaining(deadline)));
        String jobId = identifier(job.path("job_id").asText(), "job_id");

        while (true) {
            String status = job.path("status").asText();
            if ("completed".equals(status)) {
                JsonNode file = job.path("files").path(0);
                if (!"completed".equals(file.path("status").asText())) {
                    throw new IOException("MinerU 文件解析未完成: " + file);
                }
                String fileId = identifier(file.path("output_files").path("zip").path("file_id").asText(), "ZIP file_id");
                Payload zip = execute(client, new HttpGet(baseUrl + "/v1/files/" + fileId + "/content"), remaining(deadline));
                if (zip.status != 200) {
                    throw failure("MinerU ZIP 下载失败", zip);
                }
                return zip.body;
            }
            if (!"queued".equals(status) && !"running".equals(status)) {
                throw new IOException("MinerU 解析失败: " + job);
            }
            Thread.sleep(Math.min(pollIntervalMs, remaining(deadline)));
            job = readJson(execute(client, new HttpGet(baseUrl + "/v1/parse/jobs/" + jobId), remaining(deadline)));
        }
    }

    private long remaining(long deadline) throws IOException {
        long millis = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
        if (millis <= 0) {
            throw new IOException("MinerU 解析任务超时 (" + responseTimeout + " ms)");
        }
        return millis;
    }

    private Payload execute(CloseableHttpClient client, HttpUriRequestBase request, long timeout) throws IOException {
        request.setConfig(RequestConfig.custom()
                .setConnectionRequestTimeout(Timeout.ofMilliseconds(connectTimeout))
                .setResponseTimeout(Timeout.ofMilliseconds(timeout)).build());
        try (var response = client.execute(request)) {
            byte[] body = response.getEntity() == null ? new byte[0] : EntityUtils.toByteArray(response.getEntity());
            return new Payload(response.getCode(), body);
        }
    }

    private JsonNode readJson(Payload result) throws IOException {
        if (result.status < 200 || result.status >= 300) {
            throw failure("MinerU v1 接口调用失败", result);
        }
        return JSON.readTree(result.body);
    }

    private String identifier(String value, String field) throws IOException {
        if (!value.matches("[A-Za-z0-9_-]+")) {
            throw new IOException("MinerU 响应缺少有效的 " + field);
        }
        return value;
    }

    private IOException failure(String message, Payload result) {
        String body = new String(result.body, StandardCharsets.UTF_8);
        return new IOException(message + ": HTTP " + result.status + ", " + body.substring(0, Math.min(body.length(), 2000)));
    }

    private record Payload(int status, byte[] body) { }
}
