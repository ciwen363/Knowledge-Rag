package know.engine.document.service.impl;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.*;

class MinerUParseClientTest {
    private HttpServer server;
    private String baseUrl;
    private byte[] zip;

    @BeforeEach
    void startServer() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        baseUrl = "http://127.0.0.1:" + server.getAddress().getPort();
        server.start();
        try (var bytes = new ByteArrayOutputStream(); var output = new ZipOutputStream(bytes)) {
            output.putNextEntry(new ZipEntry("document.md"));
            output.write("# preserved text".getBytes(StandardCharsets.UTF_8));
            output.closeEntry();
            output.finish();
            zip = bytes.toByteArray();
        }
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    @Test
    void legacyApiKeepsMultipartOptionsAndZipUnchanged() throws Exception {
        AtomicReference<String> body = new AtomicReference<>();
        AtomicInteger v1Calls = new AtomicInteger();
        server.createContext("/file_parse", exchange -> {
            body.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            respond(exchange, 200, zip);
        });
        server.createContext("/v1", exchange -> { v1Calls.incrementAndGet(); respond(exchange, 500, "unexpected"); });

        var streamingInput = new ByteArrayInputStream("original content".getBytes(StandardCharsets.UTF_8)) {
            @Override public byte[] readAllBytes() { throw new AssertionError("Legacy uploads must remain streaming"); }
        };
        assertArrayEquals(zip, client(1000).parseZip("upload.pdf", streamingInput));
        assertTrue(body.get().contains("filename=\"upload.pdf\""));
        assertTrue(body.get().contains("original content"));
        for (String option : new String[]{"files", "backend", "response_format_zip", "return_images", "return_model_output", "return_middle_json"}) {
            assertTrue(body.get().contains("name=\"" + option + "\""));
        }
        assertEquals(0, v1Calls.get());
    }

    @Test
    void missingLegacyApiUsesV1PollsAndDownloadsOutputFileReference() throws Exception {
        AtomicReference<String> createBody = new AtomicReference<>();
        AtomicInteger polls = new AtomicInteger();
        server.createContext("/file_parse", exchange -> respond(exchange, 404, "missing"));
        server.createContext("/v1/parse/jobs", exchange -> {
            if (exchange.getRequestMethod().equals("POST")) {
                createBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
                respond(exchange, 202, "{\"job_id\":\"job_1\",\"status\":\"queued\"}");
            } else if (polls.incrementAndGet() == 1) {
                respond(exchange, 200, "{\"job_id\":\"job_1\",\"status\":\"running\"}");
            } else {
                respond(exchange, 200, "{\"job_id\":\"job_1\",\"status\":\"completed\",\"files\":[{\"status\":\"completed\",\"output_files\":{\"zip\":{\"file_id\":\"file-zip\",\"bytes\":123}}}]}");
            }
        });
        server.createContext("/v1/files/file-zip/content", exchange -> respond(exchange, 200, zip));

        assertArrayEquals(zip, client(1000).parseZip("upload.docx", stream("original docx")));
        var request = new ObjectMapper().readTree(createBody.get());
        assertEquals("basic", request.path("tier").asText());
        assertEquals("zip", request.path("output_formats").path(0).asText());
        var source = request.path("files").path(0).path("source");
        assertEquals("inline", source.path("type").asText());
        assertEquals("upload.docx", source.path("name").asText());
        assertArrayEquals("original docx".getBytes(StandardCharsets.UTF_8), Base64.getDecoder().decode(source.path("data").asText()));
        assertEquals(2, polls.get());
    }

    @Test
    void legacyServerErrorIsReportedWithoutSwitchingProtocol() {
        AtomicInteger v1Calls = new AtomicInteger();
        server.createContext("/file_parse", exchange -> respond(exchange, 500, "engine unavailable"));
        server.createContext("/v1", exchange -> { v1Calls.incrementAndGet(); respond(exchange, 500, "unexpected"); });
        var error = assertThrows(IOException.class, () -> client(1000).parseZip("upload.pdf", stream("test")));
        assertTrue(error.getMessage().contains("HTTP 500"));
        assertEquals(0, v1Calls.get());
    }

    @Test
    void failedV1JobReportsEngineError() {
        server.createContext("/file_parse", exchange -> respond(exchange, 404, "missing"));
        server.createContext("/v1/parse/jobs", exchange -> respond(exchange, 200,
                "{\"job_id\":\"job_1\",\"status\":\"failed\",\"files\":[{\"error\":{\"message\":\"missing model\"}}]}"));
        var error = assertThrows(IOException.class, () -> client(1000).parseZip("upload.pdf", stream("test")));
        assertTrue(error.getMessage().contains("missing model"));
    }

    @Test
    void v1PollingHasAnOverallTimeout() {
        server.createContext("/file_parse", exchange -> respond(exchange, 404, "missing"));
        server.createContext("/v1/parse/jobs", exchange -> respond(exchange, 200,
                "{\"job_id\":\"job_1\",\"status\":\"running\"}"));
        long start = System.nanoTime();
        var error = assertThrows(IOException.class, () -> client(300).parseZip("upload.pdf", stream("test")));
        assertTrue(error.getMessage().contains("超时") || error instanceof java.net.SocketTimeoutException);
        assertTrue(java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start) < 3000,
                "A running job must not poll indefinitely");
    }

    private MinerUParseClient client(int timeout) {
        return new MinerUParseClient(baseUrl + "/", 1000, timeout, "basic", 5);
    }

    private ByteArrayInputStream stream(String text) {
        return new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8));
    }

    private void respond(HttpExchange exchange, int status, String body) throws IOException {
        respond(exchange, status, body.getBytes(StandardCharsets.UTF_8));
    }

    private void respond(HttpExchange exchange, int status, byte[] body) throws IOException {
        exchange.getRequestBody().readAllBytes();
        exchange.sendResponseHeaders(status, body.length);
        try (var output = exchange.getResponseBody()) { output.write(body); }
        exchange.close();
    }
}
