package know.engine.rag;

import dev.langchain4j.data.segment.TextSegment;
import dev.langchain4j.model.output.Response;
import dev.langchain4j.model.scoring.ScoringModel;
import dev.langchain4j.rag.content.Content;
import dev.langchain4j.rag.content.ContentMetadata;
import dev.langchain4j.rag.query.Query;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

class KnowEngineReRankingContentAggregatorTest {
    @Test
    void preservesFullTextScoresThresholdOrderAndMetadata() {
        String longText = "完整父分块".repeat(600);
        Map<String, Double> scores = Map.of("first", 1.0, longText, 3.0, "excluded", -3.0);
        var observedTexts = new java.util.ArrayList<String>();
        ScoringModel model = (segments, query) -> {
            assertEquals(1, segments.size());
            assertEquals("original question", query);
            observedTexts.addAll(segments.stream().map(TextSegment::text).toList());
            return Response.from(segments.stream().map(s -> scores.get(s.text())).toList());
        };
        var aggregator = aggregator(model, -2.5, 2);
        var result = aggregator.reRankAndFilter(List.of(content("first"), content(longText), content("excluded")), Query.from("original question"));
        assertEquals(List.of(longText, "first"), result.stream().map(c -> c.textSegment().text()).toList());
        assertEquals("embedding-" + longText, result.get(0).metadata().get(ContentMetadata.EMBEDDING_ID));
        assertEquals(3.0, result.get(0).metadata().get(ContentMetadata.RERANKED_SCORE));
        assertEquals(List.of("first", longText, "excluded"), observedTexts);
    }

    @Test
    void keepsShortCandidateBatchUnchanged() {
        AtomicInteger calls = new AtomicInteger();
        ScoringModel model = (segments, query) -> {
            calls.incrementAndGet();
            assertEquals(List.of("a", "b", "c"), segments.stream().map(TextSegment::text).toList());
            return Response.from(List.of(2.0, 3.0, 1.0));
        };
        var result = aggregator(model, -2.5, 5).reRankAndFilter(List.of(content("a"), content("b"), content("c")), Query.from("question"));
        assertEquals(1, calls.get());
        assertEquals(List.of("b", "a", "c"), result.stream().map(c -> c.textSegment().text()).toList());
    }

    @Test
    void preservesRrfFallbackWhenAllScoresAreBelowThreshold() {
        ScoringModel model = (segments, query) -> Response.from(segments.stream().map(s -> -4.0).toList());
        var input = List.of(content("a"), content("b"), content("c"), content("d"));
        var result = aggregator(model, -2.5, 5).reRankAndFilter(input, Query.from("question"));
        assertEquals(List.of("a", "b", "c"), result.stream().map(c -> c.textSegment().text()).toList());
        assertEquals(-4.0, result.get(0).metadata().get(ContentMetadata.RERANKED_SCORE));
    }

    @Test
    void sharedModelNeverRunsConcurrentInference() throws Exception {
        AtomicInteger active = new AtomicInteger();
        AtomicInteger peak = new AtomicInteger();
        ScoringModel model = (segments, query) -> {
            assertEquals(2, segments.size());
            peak.accumulateAndGet(active.incrementAndGet(), Math::max);
            try {
                Thread.sleep(15);
                return Response.from(List.of(1.0, 1.0));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new RuntimeException(e);
            } finally { active.decrementAndGet(); }
        };
        try (var pool = Executors.newFixedThreadPool(4)) {
            var tasks = java.util.stream.IntStream.range(0, 4).mapToObj(i -> pool.submit(() ->
                    aggregator(model, -2.5, 5).reRankAndFilter(List.of(content("a"), content("b")), Query.from("question")))).toList();
            for (var task : tasks) assertEquals(2, task.get(5, TimeUnit.SECONDS).size());
        }
        assertEquals(1, peak.get());
    }

    private KnowEngineReRankingContentAggregator aggregator(ScoringModel model, Double minScore, int maxResults) {
        return new KnowEngineReRankingContentAggregator(model, map -> map.keySet().iterator().next(), minScore, maxResults);
    }

    private Content content(String text) {
        return Content.from(TextSegment.from(text), Map.of(ContentMetadata.EMBEDDING_ID, "embedding-" + text, ContentMetadata.SCORE, 0.9));
    }
}
