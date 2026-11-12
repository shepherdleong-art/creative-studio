import assert from 'node:assert/strict';
import { canvasDraftBindingEdges } from '../lib/creative-canvas/draft-binding-edges.ts';
import type { CanvasGraph } from '../lib/creative-canvas/types.ts';

const graph: CanvasGraph = { schemaVersion: 1, edges: [], nodes: [
  { id: 'sample', kind: 'material', position: { x: 0, y: 0 }, data: { title: '样片', assetId: 'fixed-sample', mediaKind: 'video' } },
  { id: 'formal', kind: 'video-generation', position: { x: 350, y: 0 }, data: {
    title: '生成正式版', modelKey: 'company-seedance-25', generationMode: 'reference-to-video', prompt: '',
    parameters: { generationStage: 'final-from-draft', draftAssetId: 'fixed-sample' }, references: [], referenceLabelCounter: 0,
  } },
] };
const before = JSON.stringify(graph);
assert.deepEqual(canvasDraftBindingEdges(graph), [{ id: 'draft-binding:formal', source: 'sample', target: 'formal' }]);
assert.equal(JSON.stringify(graph), before, 'display edges do not become video references or execution dependencies');
assert.deepEqual(canvasDraftBindingEdges(JSON.parse(JSON.stringify(graph))), canvasDraftBindingEdges(graph), 'saved binding redraws after reload');
const source = graph.nodes[0];
assert.equal(source.kind, 'material');
if (source.kind !== 'material') throw new Error('missing material');
source.data.assetId = 'newer-result';
assert.deepEqual(canvasDraftBindingEdges(graph), [], 'a replacement/newer result cannot retarget the fixed Draft');
source.data.assetId = 'fixed-sample';
graph.edges.push({ id: 'existing', source: 'sample', target: 'formal' });
assert.deepEqual(canvasDraftBindingEdges(graph), [], 'do not draw a duplicate existing edge');
graph.edges = [];
const target = graph.nodes[1];
if (target.kind !== 'video-generation') throw new Error('missing Final');
target.data.parameters.generationStage = 'direct';
assert.deepEqual(canvasDraftBindingEdges(graph), [], 'direct generation has no Draft binding');
console.log('creative-canvas-draft-binding.test.ts passed');
