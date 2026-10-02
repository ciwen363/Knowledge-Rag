package know.engine.rag;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import dev.langchain4j.data.document.Metadata;
import dev.langchain4j.data.segment.TextSegment;
import know.engine.document.entity.KnowledgeSegment;
import know.engine.document.service.SegmentService;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class ParentChunkScoringSegmentsTest {
    private TextSegment parent() {
        return TextSegment.from("完整父分块", new Metadata(Map.of("parentChunkId", "parent", "docId", 4, "version", 1)));
    }

    private KnowledgeSegment child(String text) {
        var child = new KnowledgeSegment();
        child.setText(text);
        return child;
    }

    @Test
    void ordinaryCandidatesKeepTheirOriginalTextWithoutDatabaseReads() {
        var service = mock(SegmentService.class);
        var context = TextSegment.from("普通分块全文");
        var passages = new ParentChunkScoringSegments(service).apply(context);
        assertEquals(List.of(context), passages);
        verifyNoInteractions(service);
    }

    @Test
    @SuppressWarnings("unchecked")
    void loadsFullChildPassagesOnceWithinTheOriginalDocumentAndVersion() {
        var service = mock(SegmentService.class);
        when(service.list(any(QueryWrapper.class))).thenAnswer(invocation -> {
            QueryWrapper<KnowledgeSegment> query = invocation.getArgument(0);
            assertTrue(query.getSqlSegment().contains("document_id"));
            assertTrue(query.getSqlSegment().contains("document_version"));
            assertTrue(query.getParamNameValuePairs().values().containsAll(List.of(0, 4, 1, "parent")));
            return List.of(child("第一子分块完整正文"), child("第二子分块完整正文"));
        });
        var provider = new ParentChunkScoringSegments(service);
        var context = parent();
        var passages = provider.apply(context);
        assertEquals(List.of("第一子分块完整正文", "第二子分块完整正文"), passages.stream().map(TextSegment::text).toList());
        assertSame(passages, provider.apply(context));
        assertEquals("完整父分块", context.text());
        verify(service, times(1)).list(any(QueryWrapper.class));
    }

    @Test
    @SuppressWarnings("unchecked")
    void missingPassagesOrUnavailableDatabaseRetainTheCompleteParent() {
        var service = mock(SegmentService.class);
        var context = parent();
        when(service.list(any(QueryWrapper.class))).thenReturn(List.of());
        assertEquals(List.of(context), new ParentChunkScoringSegments(service).apply(context));
        when(service.list(any(QueryWrapper.class))).thenThrow(new IllegalStateException("database unavailable"));
        assertEquals(List.of(context), new ParentChunkScoringSegments(service).apply(context));
    }
}
