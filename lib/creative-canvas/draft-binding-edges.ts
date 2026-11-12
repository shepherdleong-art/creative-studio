import type { CanvasGraph, CanvasGraphEdge } from './types.ts';

/** Display the immutable Draft binding without adding a reference or execution dependency. */
export function canvasDraftBindingEdges(graph: CanvasGraph): CanvasGraphEdge[] {
  return graph.nodes.flatMap((node) => {
    if (node.kind !== 'video-generation' || node.data.parameters.generationStage !== 'final-from-draft') return [];
    const assetId = node.data.parameters.draftAssetId;
    if (typeof assetId !== 'string' || !assetId) return [];
    const source = graph.nodes.find((candidate) => candidate.kind === 'material'
      && candidate.data.mediaKind === 'video' && candidate.data.assetId === assetId);
    if (!source || graph.edges.some((edge) => edge.source === source.id && edge.target === node.id)) return [];
    return [{ id: `draft-binding:${node.id}`, source: source.id, target: node.id }];
  });
}
