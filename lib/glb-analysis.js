'use strict';

const COMPONENTS = {
  5120: { bytes: 1, read: (buffer, offset) => buffer.readInt8(offset), min: -127, max: 127 },
  5121: { bytes: 1, read: (buffer, offset) => buffer.readUInt8(offset), max: 255 },
  5122: { bytes: 2, read: (buffer, offset) => buffer.readInt16LE(offset), min: -32767, max: 32767 },
  5123: { bytes: 2, read: (buffer, offset) => buffer.readUInt16LE(offset), max: 65535 },
  5125: { bytes: 4, read: (buffer, offset) => buffer.readUInt32LE(offset), max: 4294967295 },
  5126: { bytes: 4, read: (buffer, offset) => buffer.readFloatLE(offset) }
};

const TYPE_WIDTHS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function parseGlb(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20 || buffer.toString('ascii', 0, 4) !== 'glTF') {
    throw new Error('File bukan GLB yang valid.');
  }

  if (buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.length) {
    throw new Error('GLB harus menggunakan versi 2 dengan ukuran header yang sesuai.');
  }

  let offset = 12;
  let document;
  let binaryChunk;

  while (offset + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.readUInt32LE(offset + 4);
    offset += 8;
    if (chunkLength > buffer.length - offset) {
      throw new Error('Struktur chunk GLB tidak valid.');
    }

    const chunk = buffer.subarray(offset, offset + chunkLength);
    if (chunkType === 0x4e4f534a) {
      try {
        document = JSON.parse(chunk.toString('utf8').replace(/\0+$/u, '').trim());
      } catch {
        throw new Error('Metadata JSON di dalam GLB tidak dapat dibaca.');
      }
    } else if (chunkType === 0x004e4942) {
      binaryChunk = chunk;
    }
    offset += chunkLength;
  }

  if (!document || !Array.isArray(document.nodes) || !Array.isArray(document.meshes)) {
    throw new Error('GLB tidak berisi struktur model yang didukung.');
  }
  if (document.buffers?.some(item => item.uri)) {
    throw new Error('GLB dengan buffer eksternal tidak didukung. Ekspor semua aset ke satu file GLB.');
  }

  return { document, binaryChunk: binaryChunk || Buffer.alloc(0) };
}

function readAccessor(document, binaryChunk, accessorIndex) {
  const accessor = document.accessors?.[accessorIndex];
  if (!accessor || accessor.sparse) {
    throw new Error('Accessor geometri GLB tidak didukung atau tidak lengkap.');
  }
  const width = TYPE_WIDTHS[accessor.type];
  const component = COMPONENTS[accessor.componentType];
  if (!width || !component || !Number.isSafeInteger(accessor.count) || accessor.count < 0) {
    throw new Error('Format data geometri GLB tidak didukung.');
  }
  if (accessor.count * width > 6_000_000) {
    throw new Error('Model terlalu kompleks untuk dianalisis di satu proses.');
  }

  const values = new Float64Array(accessor.count * width);
  if (accessor.bufferView === undefined) {
    return { accessor, values, width };
  }

  const view = document.bufferViews?.[accessor.bufferView];
  if (!view || (view.buffer || 0) !== 0) {
    throw new Error('Buffer view GLB tidak valid.');
  }
  const stride = view.byteStride || component.bytes * width;
  const start = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const end = start + Math.max(0, accessor.count - 1) * stride + component.bytes * width;
  if (end > binaryChunk.length || stride < component.bytes * width) {
    throw new Error('Rentang data geometri berada di luar buffer GLB.');
  }

  for (let row = 0; row < accessor.count; row += 1) {
    for (let column = 0; column < width; column += 1) {
      let value = component.read(binaryChunk, start + row * stride + column * component.bytes);
      if (accessor.normalized && accessor.componentType !== 5126) {
        value = component.min === undefined
          ? value / component.max
          : Math.max(value / component.max, -1);
      }
      values[row * width + column] = value;
    }
  }
  return { accessor, values, width };
}

function multiplyMatrices(a, b) {
  const result = new Float64Array(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let index = 0; index < 4; index += 1) {
        result[column * 4 + row] += a[index * 4 + row] * b[column * 4 + index];
      }
    }
  }
  return result;
}

function nodeMatrix(node) {
  if (node.matrix?.length === 16) return new Float64Array(node.matrix);

  const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;

  return new Float64Array([
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1
  ]);
}

function transformPoint(matrix, x, y, z) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
  ];
}

function materialColor(document, index) {
  const factor = document.materials?.[index]?.pbrMetallicRoughness?.baseColorFactor;
  if (!factor) return '#d5d0c5';
  return `#${factor.slice(0, 3).map(value =>
    Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0')
  ).join('')}`;
}

function getTriangleIndices(document, binaryChunk, primitive, vertexCount) {
  if (primitive.indices === undefined) {
    return { indices: null, count: vertexCount };
  }
  const decoded = readAccessor(document, binaryChunk, primitive.indices);
  if (decoded.width !== 1) throw new Error('Accessor indeks GLB harus berupa nilai skalar.');
  return { indices: decoded.values, count: decoded.values.length };
}

function getIndex(indices, index) {
  return indices ? indices[index] : index;
}

function buildSvgPreview(geometries, bounds, title) {
  const points = [];
  const facets = [];
  let depthIndex = 0;
  const maxFacets = 2200;
  const totalTriangles = geometries.reduce((sum, geometry) => sum + geometry.triangleCount, 0);
  const sampleStride = Math.max(1, Math.ceil(totalTriangles / maxFacets));
  let triangleNumber = 0;

  for (const geometry of geometries) {
    for (let triangle = 0; triangle < geometry.triangleCount; triangle += sampleStride) {
      const vertices = [0, 1, 2].map(corner => {
        const index = getIndex(geometry.indices, triangle * 3 + corner);
        const start = index * 3;
        const x = geometry.positions[start];
        const y = geometry.positions[start + 1];
        const z = geometry.positions[start + 2];
        return { x, y, z, projectedX: (x - z) * 0.707, projectedY: (x + z) * 0.408 - y * 0.816 };
      });
      if (vertices.some(vertex => !Number.isFinite(vertex.projectedX) || !Number.isFinite(vertex.projectedY))) continue;
      vertices.forEach(vertex => points.push(vertex));
      facets.push({
        vertices,
        depth: vertices.reduce((sum, vertex) => sum + vertex.x + vertex.z - vertex.y, 0) / 3,
        color: geometry.color,
        order: depthIndex
      });
      depthIndex += 1;
      triangleNumber += 1;
      if (triangleNumber >= maxFacets) break;
    }
    if (triangleNumber >= maxFacets) break;
  }

  const minX = points.length ? Math.min(...points.map(point => point.projectedX)) : 0;
  const maxX = points.length ? Math.max(...points.map(point => point.projectedX)) : 1;
  const minY = points.length ? Math.min(...points.map(point => point.projectedY)) : 0;
  const maxY = points.length ? Math.max(...points.map(point => point.projectedY)) : 1;
  const spanX = Math.max(maxX - minX, 0.001);
  const spanY = Math.max(maxY - minY, 0.001);
  const scale = Math.min(720 / spanX, 390 / spanY);
  const xOffset = (800 - spanX * scale) / 2 - minX * scale;
  const yOffset = 460 - (500 - spanY * scale) / 2 + minY * scale;
  facets.sort((a, b) => b.depth - a.depth || a.order - b.order);
  const polygons = facets.map(facet => {
    const coords = facet.vertices.map(vertex =>
      `${(vertex.projectedX * scale + xOffset).toFixed(1)},${(yOffset - vertex.projectedY * scale).toFixed(1)}`
    ).join(' ');
    return `<polygon points="${coords}" fill="${facet.color}" stroke="#2b2b28" stroke-width="0.6"/>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" role="img" aria-label="Pratinjau model ${escapeXml(title)}">
    <rect width="800" height="500" fill="#efeee9"/>
    ${polygons || `<path d="M170 300 400 180 630 300 400 420Z" fill="#d5d0c5" stroke="#2b2b28"/>`}
    <g font-family="monospace" font-size="12" fill="#5c5b57">
      <text x="24" y="34">${escapeXml(title)}</text>
      <text x="24" y="478">${bounds.width.toFixed(2)} × ${bounds.depth.toFixed(2)} × ${bounds.height.toFixed(2)} m</text>
    </g>
  </svg>`;
}

function formatDimension(value) {
  return value.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildFloorPlanSvg(geometry, bounds, floor, floorCount, northDegrees, projectTitle) {
  const elevation = Number.isFinite(floor.elevation)
    ? floor.elevation
    : bounds.minY + (floor.index + 0.62) * (bounds.height / floorCount);
  const segments = [];
  const maxSegments = 15000;

  for (const mesh of geometry) {
    const indices = mesh.indices;
    for (let triangle = 0; triangle < mesh.triangleCount && segments.length < maxSegments; triangle += 1) {
      const vertices = [0, 1, 2].map(corner => {
        const index = getIndex(indices, triangle * 3 + corner);
        const start = index * 3;
        return [mesh.positions[start], mesh.positions[start + 1], mesh.positions[start + 2]];
      });
      const intersections = [];
      for (let edge = 0; edge < 3; edge += 1) {
        const a = vertices[edge];
        const b = vertices[(edge + 1) % 3];
        if ((a[1] <= elevation && b[1] > elevation) || (b[1] <= elevation && a[1] > elevation)) {
          const ratio = (elevation - a[1]) / (b[1] - a[1]);
          const point = [a[0] + (b[0] - a[0]) * ratio, a[2] + (b[2] - a[2]) * ratio];
          if (!intersections.some(existing => Math.hypot(existing[0] - point[0], existing[1] - point[1]) < 0.00001)) {
            intersections.push(point);
          }
        }
      }
      if (intersections.length === 2) segments.push(intersections);
    }
  }

  const padding = 44;
  const drawingWidth = 266;
  const drawingHeight = 154;
  const spanX = Math.max(bounds.width, 0.001);
  const spanZ = Math.max(bounds.depth, 0.001);
  const scale = Math.min(drawingWidth / spanX, drawingHeight / spanZ);
  const offsetX = 68 + (drawingWidth - spanX * scale) / 2;
  const offsetY = 44 + (drawingHeight - spanZ * scale) / 2;
  const mapPoint = point => [
    offsetX + (point[0] - bounds.minX) * scale,
    offsetY + (point[1] - bounds.minZ) * scale
  ];
  const sectionPaths = segments.map(segment => {
    const [a, b] = segment.map(mapPoint);
    return `<line x1="${a[0].toFixed(2)}" y1="${(220 - a[1]).toFixed(2)}" x2="${b[0].toFixed(2)}" y2="${(220 - b[1]).toFixed(2)}"/>`;
  }).join('');
  const fallback = segments.length === 0;
  const fallbackOutline = fallback
    ? `<rect x="68" y="54" width="266" height="134" fill="none" stroke="#5c5b57" stroke-width="1.5"/>`
    : '';
  const gridsX = Array.from({ length: 5 }, (_, index) => {
    const x = 68 + index * (266 / 4);
    return `<line x1="${x}" y1="42" x2="${x}" y2="196"/>`;
  }).join('');
  const gridsY = Array.from({ length: 4 }, (_, index) => {
    const y = 44 + index * (154 / 3);
    return `<line x1="58" y1="${y}" x2="344" y2="${y}"/>`;
  }).join('');
  const columnLabels = Array.from({ length: 5 }, (_, index) => {
    const x = 68 + index * (266 / 4);
    return `<circle cx="${x}" cy="27" r="8" fill="#efeee9" stroke="#e85325"/><text x="${x}" y="29.5" text-anchor="middle" fill="#e85325" font-size="7">${index + 1}</text>`;
  }).join('');
  const rowLabels = Array.from({ length: 4 }, (_, index) => {
    const y = 44 + index * (154 / 3);
    return `<circle cx="48" cy="${y}" r="8" fill="#efeee9" stroke="#e85325"/><text x="48" y="${y + 2.5}" text-anchor="middle" fill="#e85325" font-size="7">${String.fromCharCode(65 + index)}</text>`;
  }).join('');
  const dimension = formatDimension(bounds.width / 4);
  const north = Number.isFinite(northDegrees) ? northDegrees : 0;
  const title = floor.title;
  const warning = fallback ? 'Garis potongan tidak terdeteksi; tampilan hanya batas model.' : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 250" role="img" aria-label="Denah ${escapeXml(title)} untuk ${escapeXml(projectTitle)}">
    <rect width="420" height="250" fill="#f5f4f0"/>
    <g fill="none" stroke="#e85325" stroke-width="0.7" stroke-dasharray="4 3" opacity="0.38">${gridsX}${gridsY}</g>
    <g fill="none" stroke="#1a1a18" stroke-width="1.4">${sectionPaths}${fallbackOutline}</g>
    <g font-family="monospace">${columnLabels}${rowLabels}</g>
    <g stroke="#1a1a18" stroke-width="0.6" fill="none">
      ${Array.from({ length: 4 }, (_, index) => {
        const x1 = 68 + index * (266 / 4);
        const x2 = 68 + (index + 1) * (266 / 4);
        const mid = (x1 + x2) / 2;
        return `<line x1="${x1}" y1="207" x2="${x2}" y2="207"/><text x="${mid}" y="220" text-anchor="middle" stroke="none" fill="#5c5b57" font-size="6">${dimension} m</text>`;
      }).join('')}
    </g>
    <g transform="translate(382 52) rotate(${north})" font-family="monospace" text-anchor="middle">
      <circle r="12" fill="#efeee9" stroke="#2b2b28" stroke-width="0.8"/>
      <path d="M0 -10 L-3 3 L0 1 L3 3 Z" fill="#e85325"/>
      <path d="M0 10 L-2 3 L0 4 L2 3 Z" fill="#2b2b28"/>
      <text y="-15" font-size="7" fill="#1a1a18">U</text><text y="19" font-size="6" fill="#5c5b57">S</text>
      <text x="-16" y="2" font-size="6" fill="#5c5b57">B</text><text x="16" y="2" font-size="6" fill="#5c5b57">T</text>
      <title>Arah mata angin: Utara, Timur, Selatan, Barat</title>
    </g>
    <g font-family="monospace" fill="#1a1a18"><text x="12" y="14" font-size="10">${escapeXml(title)} · ${escapeXml(formatDimension(elevation))} m</text>
      <text x="12" y="244" font-size="7" fill="#5c5b57">${escapeXml(warning)}</text></g>
  </svg>`;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/gu, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  })[character]);
}

function analyzeGlb(buffer, options = {}) {
  const { document, binaryChunk } = parseGlb(buffer);
  const geometries = [];
  const nodeNames = [];
  const bounds = {
    minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity
  };
  let vertexTotal = 0;
  let triangleTotal = 0;
  const materials = document.materials || [];

  function visitNode(nodeIndex, parentMatrix, stack) {
    if (stack.has(nodeIndex)) throw new Error('Struktur node GLB memiliki siklus.');
    const node = document.nodes[nodeIndex];
    if (!node) throw new Error('Node GLB merujuk ke indeks yang tidak valid.');
    if (node.name) nodeNames.push(node.name);
    const matrix = multiplyMatrices(parentMatrix, nodeMatrix(node));

    if (node.mesh !== undefined) {
      const mesh = document.meshes[node.mesh];
      if (!mesh) throw new Error('Node GLB merujuk ke mesh yang tidak valid.');
      for (const primitive of mesh.primitives || []) {
        if (primitive.mode !== undefined && primitive.mode !== 4) continue;
        const positionIndex = primitive.attributes?.POSITION;
        if (positionIndex === undefined) continue;
        const decoded = readAccessor(document, binaryChunk, positionIndex);
        if (decoded.width !== 3) throw new Error('Atribut posisi mesh harus berupa VEC3.');
        vertexTotal += decoded.accessor.count;
        if (vertexTotal > 1_500_000) throw new Error('Model berisi terlalu banyak titik untuk analisis otomatis.');

        const positions = new Float64Array(decoded.accessor.count * 3);
        for (let vertex = 0; vertex < decoded.accessor.count; vertex += 1) {
          const base = vertex * 3;
          const world = transformPoint(matrix, decoded.values[base], decoded.values[base + 1], decoded.values[base + 2]);
          positions[base] = world[0];
          positions[base + 1] = world[1];
          positions[base + 2] = world[2];
          bounds.minX = Math.min(bounds.minX, world[0]);
          bounds.minY = Math.min(bounds.minY, world[1]);
          bounds.minZ = Math.min(bounds.minZ, world[2]);
          bounds.maxX = Math.max(bounds.maxX, world[0]);
          bounds.maxY = Math.max(bounds.maxY, world[1]);
          bounds.maxZ = Math.max(bounds.maxZ, world[2]);
        }

        const indexInfo = getTriangleIndices(document, binaryChunk, primitive, decoded.accessor.count);
        const triangleCount = Math.floor(indexInfo.count / 3);
        triangleTotal += triangleCount;
        if (triangleTotal > 2_000_000) throw new Error('Model berisi terlalu banyak segitiga untuk analisis otomatis.');
        geometries.push({
          positions,
          indices: indexInfo.indices,
          triangleCount,
          color: materialColor(document, primitive.material)
        });
      }
    }

    const nextStack = new Set(stack);
    nextStack.add(nodeIndex);
    for (const child of node.children || []) visitNode(child, matrix, nextStack);
  }

  const identity = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const sceneNodes = document.scenes?.[document.scene || 0]?.nodes;
  const roots = sceneNodes || document.nodes.map((_, index) => index).filter(index =>
    !document.nodes.some(node => node.children?.includes(index))
  );
  for (const root of roots) visitNode(root, identity, new Set());

  if (!Number.isFinite(bounds.minX) || triangleTotal === 0) {
    throw new Error('GLB tidak memiliki mesh segitiga yang dapat dirender.');
  }

  const dimensions = {
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
    depth: bounds.maxZ - bounds.minZ
  };
  if (Object.values(dimensions).some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error('Ukuran model tidak valid. Periksa skala dan geometri di SketchUp.');
  }

  const namedFloors = nodeNames.map(name => {
    const match = name.match(/(?:floor|level|storey|lantai)\s*[-_#]?\s*(\d+)/iu);
    return match ? Number(match[1]) : null;
  }).filter(Number.isInteger);
  const estimatedFloors = namedFloors.length
    ? Math.max(1, ...namedFloors)
    : Math.max(1, Math.min(12, Math.round(dimensions.height / 3.4)));
  const requestedFloors = Number(options.floorCount);
  const explicitFloors = options.floors;
  if (explicitFloors !== undefined && (!Array.isArray(explicitFloors) || explicitFloors.length < 1 || explicitFloors.length > 12)) {
    throw new Error('Manifest harus memiliki 1 sampai 12 lantai.');
  }
  if (explicitFloors && Number.isInteger(requestedFloors) && requestedFloors !== explicitFloors.length) {
    throw new Error('Jumlah lantai tidak sesuai dengan manifest.');
  }
  const floorCount = explicitFloors
    ? explicitFloors.length
    : Number.isInteger(requestedFloors) && requestedFloors >= 1 && requestedFloors <= 12
    ? requestedFloors
    : estimatedFloors;
  const title = String(options.title || 'Proyek Arsitektur').slice(0, 100);
  const northDegrees = ((Number(options.northDegrees) || 0) % 360 + 360) % 360;
  const floorLabels = Array.isArray(options.floorLabels) ? options.floorLabels : [];
  const floors = explicitFloors
    ? explicitFloors.map((floor, index) => {
      const floorTitle = String(floor.title || floor.name || '').trim().slice(0, 50);
      const elevationRatio = floor.elevationRatio;
      const baseElevationRatio = floor.baseElevationRatio;
      if (
        (elevationRatio !== undefined &&
          (typeof elevationRatio !== 'number' || !Number.isFinite(elevationRatio) || elevationRatio <= 0 || elevationRatio >= 1)) ||
        (baseElevationRatio !== undefined &&
          (typeof baseElevationRatio !== 'number' || !Number.isFinite(baseElevationRatio) || baseElevationRatio < 0 || baseElevationRatio >= 1))
      ) {
        throw new Error(`Proporsi elevasi lantai ${index + 1} pada manifest tidak valid.`);
      }
      const elevation = elevationRatio !== undefined
        ? bounds.minY + elevationRatio * dimensions.height
        : Number(floor.elevation);
      if (!floorTitle || !Number.isFinite(elevation) || elevation <= bounds.minY || elevation >= bounds.maxY) {
        throw new Error(`Nama atau elevasi potongan lantai ${index + 1} pada manifest tidak valid.`);
      }
      if (explicitFloors.slice(0, index).some(existing =>
        String(existing.title || existing.name || '').trim().toLocaleLowerCase('id-ID') === floorTitle.toLocaleLowerCase('id-ID'))) {
        throw new Error('Nama lantai pada manifest harus unik.');
      }
      const baseElevation = baseElevationRatio !== undefined
        ? bounds.minY + baseElevationRatio * dimensions.height
        : Number(floor.baseElevation);
      return {
        index,
        title: floorTitle,
        elevation,
        ...(Number.isFinite(baseElevation) ? { baseElevation } : {}),
        ...(typeof floor.groupName === 'string' ? { groupName: floor.groupName.slice(0, 100) } : {}),
        fileName: `denah-lantai-${index + 1}.svg`
      };
    })
    : Array.from({ length: floorCount }, (_, index) => ({
      index,
      title: String(floorLabels[index] || (index === 0 ? 'Lantai dasar' : `Lantai ${index + 1}`)).slice(0, 50),
      elevation: bounds.minY + (index + 0.62) * (dimensions.height / floorCount),
      fileName: `denah-lantai-${index + 1}.svg`
    }));
  const plans = floors.map(floor => ({
    ...floor,
    svg: buildFloorPlanSvg(geometries, bounds, floor, floorCount, northDegrees, title)
  }));

  return {
    metadata: {
      dimensions,
      bounds,
      floorCount,
      estimatedFloorCount: estimatedFloors,
      floorSource: explicitFloors ? (options.floorSource || 'sketchup-manifest') : 'estimated',
      nodeNames: Array.from(new Set(nodeNames)).slice(0, 100),
      triangleCount: triangleTotal,
      vertexCount: vertexTotal,
      northDegrees
    },
    previewSvg: buildSvgPreview(geometries, dimensions, title),
    floors: plans
  };
}

module.exports = { analyzeGlb, escapeXml, parseGlb };
