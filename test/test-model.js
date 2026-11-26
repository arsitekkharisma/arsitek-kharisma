'use strict';

function createTestGlb() {
  const coordinates = [
    0, 0, 0, 4, 0, 0, 4, 3, 0, 0, 3, 0,
    0, 0, 2, 4, 0, 2, 4, 3, 2, 0, 3, 2
  ];
  const positions = Buffer.alloc(coordinates.length * 4);
  coordinates.forEach((value, index) => positions.writeFloatLE(value, index * 4));
  const indices = Buffer.alloc(24);
  [0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6].forEach((value, index) => indices.writeUInt16LE(value, index * 2));
  const binary = Buffer.concat([positions, indices]);
  const document = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length },
      { buffer: 0, byteOffset: positions.length, byteLength: indices.length }
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 12, type: 'SCALAR' }
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    nodes: [{ name: 'Lantai 1', mesh: 0, translation: [1, 2, 3] }],
    scenes: [{ nodes: [0] }],
    scene: 0
  };
  let json = Buffer.from(JSON.stringify(document));
  const jsonPadding = (4 - json.length % 4) % 4;
  if (jsonPadding) json = Buffer.concat([json, Buffer.alloc(jsonPadding, 0x20)]);
  const binaryPadding = (4 - binary.length % 4) % 4;
  const paddedBinary = binaryPadding ? Buffer.concat([binary, Buffer.alloc(binaryPadding)]) : binary;
  const header = Buffer.alloc(12);
  header.write('glTF', 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8 + paddedBinary.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(paddedBinary.length, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, json, binaryHeader, paddedBinary]);
}

module.exports = { createTestGlb };
