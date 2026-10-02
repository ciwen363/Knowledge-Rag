package know.engine.rag;

import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import dev.langchain4j.data.segment.TextSegment;
import know.engine.document.entity.KnowledgeSegment;
import know.engine.document.service.SegmentService;
import lombok.extern.slf4j.Slf4j;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

import static know.engine.rag.constant.MetadataKeyConstant.PARENT_CHUNK_ID;

/** Scores parent context through its actual child passages without shortening the returned context. */
@Slf4j
public final class ParentChunkScoringSegments implements Function<TextSegment, List<TextSegment>> {
    private final SegmentService segmentService;
    private final Map<String, List<TextSegment>> children = new HashMap<>();

    public ParentChunkScoringSegments(SegmentService segmentService) {
        this.segmentService = segmentService;
    }

    @Override
    public List<TextSegment> apply(TextSegment context) {
        String parentId = context.metadata().getString(PARENT_CHUNK_ID);
        if (parentId == null || segmentService == null) return List.of(context);
        List<TextSegment> passages = children.computeIfAbsent(parentId, key -> loadChildren(context, key));
        return passages.isEmpty() ? List.of(context) : passages;
    }

    private List<TextSegment> loadChildren(TextSegment context, String parentId) {
        try {
            var metadata = context.metadata().toMap();
            var query = new QueryWrapper<KnowledgeSegment>()
                    .eq("skip_embedding", 0)
                    .eq(metadata.get("docId") != null, "document_id", metadata.get("docId"))
                    .eq(metadata.get("version") != null, "document_version", metadata.get("version"))
                    .apply("JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.parentChunkId')) = {0}", parentId)
                    .orderByAsc("chunk_order");
            return segmentService.list(query).stream()
                    .filter(segment -> segment.getText() != null && !segment.getText().isBlank())
                    .map(segment -> TextSegment.from(segment.getText()))
                    .toList();
        } catch (RuntimeException error) {
            log.warn("Parent scoring passages unavailable, retaining full context: parentChunkId={}", parentId, error);
            return List.of();
        }
    }
}
