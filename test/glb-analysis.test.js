'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');
const { analyzeGlb, parseGlb } = require('../lib/glb-analysis');
const { createTestGlb } = require('./test-model');

test('reads GLB scene and computes transformed model dimensions', () => {
  const result = analyzeGlb(createTestGlb(), { title: 'Uji Model', floorCount: 2, northDegrees: 135 });
  assert.deepEqual(result.metadata.dimensions, { width: 4, height: 3, depth: 2 });
  assert.deepEqual(result.metadata.bounds, {
    minX: 1, minY: 2, minZ: 3, maxX: 5, maxY: 5, maxZ: 5
  });
  assert.equal(result.metadata.floorCount, 2);
  assert.equal(result.metadata.northDegrees, 135);
  assert.equal(result.floors.length, 2);
  assert.match(result.previewSvg, /<polygon/u);
  assert.match(result.floors[0].svg, /Arah mata angin/u);
});

test('uses explicit SketchUp group elevations for each floor plan', () => {
  const result = analyzeGlb(createTestGlb(), {
    title: 'Uji Manifest',
    northDegrees: 45,
    floorSource: 'sketchup-manifest',
    floors: [
      { title: 'Lantai Dasar', groupName: 'Lantai Dasar', baseElevation: 2, elevation: 3.2 },
      { title: 'Lantai 1', groupName: 'Lantai 1', baseElevation: 3.5, elevation: 4.6 }
    ]
  });
  assert.equal(result.metadata.floorSource, 'sketchup-manifest');
  assert.deepEqual(result.floors.map(floor => floor.elevation), [3.2, 4.6]);
  assert.deepEqual(result.floors.map(floor => floor.baseElevation), [2, 3.5]);
  assert.match(result.floors[0].svg, /Lantai Dasar · 3,20 m/u);
});

test('rejects explicit floor cuts outside the GLB model bounds', () => {
  assert.throws(() => analyzeGlb(createTestGlb(), {
    floors: [{ title: 'Lantai dasar', baseElevation: 2, elevation: 5 }]
  }), /elevasi potongan lantai 1/u);
});

test('rejects invalid GLB headers', () => {
  assert.throws(() => parseGlb(Buffer.from('not a model')), /bukan GLB yang valid/u);
});

test('gzip model copy restores the original file byte-for-byte', () => {
  const original = createTestGlb();
  const compressed = zlib.gzipSync(original, { level: 9, mtime: 0 });
  assert.deepEqual(zlib.gunzipSync(compressed), original);
});
