/* 自动布局 v2：确定性纯几何求解。输入/输出均为实际输出像素与画布百分比。 */
(function (global) {
  'use strict';

  var EPS_RATIO = 0.0001;
  function scaleFor(width, height) { return Math.min(width / 1080, height / 1440); }
  function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
  function cloneBox(box) { return { left: box.left, top: box.top, right: box.right, bottom: box.bottom }; }
  function translateBox(box, dx, dy) { return { left: box.left + dx, top: box.top + dy, right: box.right + dx, bottom: box.bottom + dy }; }
  function expanded(box, amount) { return { left: box.left - amount, top: box.top - amount, right: box.right + amount, bottom: box.bottom + amount }; }
  function intersects(a, b, epsilon) {
    return a.left < b.right - epsilon && a.right > b.left + epsilon && a.top < b.bottom - epsilon && a.bottom > b.top + epsilon;
  }
  function quantize(value, step) { return Math.round(value / step) * step; }
  function rounded(value) { return Math.round(value * 1e8) / 1e8; }

  function fnv1a(text) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return ('00000000' + hash.toString(16)).slice(-8);
  }

  function movableSticker(element) {
    return element.kind === 'sticker' && element.layoutVersion === 2 && element.positionPinned !== true && element.stage !== 'ending';
  }
  function movableCue(element) {
    return element.kind === 'pointCue' && element.layoutVersion === 2 && element.positionPinned !== true && element.manualLayout !== true;
  }
  function potentiallyMovable(element) { return movableSticker(element) || movableCue(element); }

  function normalizeElements(input) {
    return input.elements.map(function (element, index) {
      var centerX = element.centerXPct / 100 * input.outputWidth;
      var centerY = element.centerYPct / 100 * input.outputHeight;
      var frames = (element.frames || []).filter(function (frame) {
        return frame && frame.opacity > 0 && Number.isSafeInteger(frame.frame) && frame.frame >= 0
          && frame.box && finite(frame.box.left) && finite(frame.box.top) && finite(frame.box.right) && finite(frame.box.bottom)
          && frame.box.right > frame.box.left && frame.box.bottom > frame.box.top;
      }).map(function (frame) { return { frame: frame.frame, opacity: frame.opacity, box: cloneBox(frame.box) }; });
      frames.sort(function (a, b) { return a.frame - b.frame; });
      return {
        source: element,
        id: String(element.id), kind: element.kind, stage: element.stage,
        layoutVersion: element.layoutVersion, positionPinned: element.positionPinned, manualLayout: element.manualLayout,
        centerX: centerX, centerY: centerY, frames: frames,
        frameMap: new Map(frames.map(function (frame) { return [frame.frame, frame]; })),
        order: index,
      };
    }).sort(function (a, b) { return a.order - b.order || a.id.localeCompare(b.id); });
  }

  function centerBounds(element, width, height) {
    var minDx = -Infinity, maxDx = Infinity, minDy = -Infinity, maxDy = Infinity;
    for (var i = 0; i < element.frames.length; i += 1) {
      var box = element.frames[i].box;
      minDx = Math.max(minDx, -box.left);
      maxDx = Math.min(maxDx, width - box.right);
      minDy = Math.max(minDy, -box.top);
      maxDy = Math.min(maxDy, height * 0.4 - box.bottom);
    }
    if (!element.frames.length) return null;
    // 可见外框可以相对模板锚点偏移，但持久化中心本身仍必须落在画布 0–100% 内。
    var minX = Math.max(0, element.centerX + minDx);
    var maxX = Math.min(width, element.centerX + maxDx);
    if (element.centerX < width / 2) maxX = Math.min(maxX, width / 2);
    else minX = Math.max(minX, width / 2);
    var minY = Math.max(0, element.centerY + minDy);
    var maxY = Math.min(height, element.centerY + maxDy);
    return minX <= maxX + EPS_RATIO && minY <= maxY + EPS_RATIO
      ? { minX: minX, maxX: maxX, minY: minY, maxY: maxY }
      : null;
  }

  function makeCandidate(element, x, y, quantization) {
    return {
      x: quantize(x, quantization), y: quantize(y, quantization),
      distance: Math.hypot(x - element.centerX, y - element.centerY),
    };
  }

  function domainFor(element, width, height, scale, limit) {
    var bounds = centerBounds(element, width, height);
    if (!bounds) return { candidates: [], truncated: false };
    var coarse = 4 * scale;
    var fine = scale;
    var quantization = Math.max(0.1, 0.1 * scale);
    var cap = 512;
    var values = new Map();
    var minX = bounds.minX, maxX = bounds.maxX, minY = bounds.minY, maxY = bounds.maxY;
    if (limit !== null) {
      minX = Math.max(minX, element.centerX - limit);
      maxX = Math.min(maxX, element.centerX + limit);
      minY = Math.max(minY, element.centerY - limit);
      maxY = Math.min(maxY, element.centerY + limit);
    }
    function add(x, y) {
      if (x < bounds.minX - EPS_RATIO || x > bounds.maxX + EPS_RATIO || y < bounds.minY - EPS_RATIO || y > bounds.maxY + EPS_RATIO) return;
      if (limit !== null && Math.hypot(x - element.centerX, y - element.centerY) > limit + EPS_RATIO) return;
      var candidate = makeCandidate(element, x, y, quantization);
      var key = candidate.x.toFixed(4) + '/' + candidate.y.toFixed(4);
      if (!values.has(key)) values.set(key, candidate);
    }
    add(element.centerX, element.centerY);
    for (var fx = -1; fx <= 1; fx += 1) for (var fy = -1; fy <= 1; fy += 1) add(element.centerX + fx * fine, element.centerY + fy * fine);
    if (minX <= maxX && minY <= maxY) {
      var startX = element.centerX + Math.floor((minX - element.centerX) / coarse) * coarse;
      var startY = element.centerY + Math.floor((minY - element.centerY) / coarse) * coarse;
      for (var x = startX; x <= maxX + EPS_RATIO; x += coarse) {
        for (var y = startY; y <= maxY + EPS_RATIO; y += coarse) add(x, y);
      }
      add(minX, minY); add(minX, maxY); add(maxX, minY); add(maxX, maxY);
    }
    var candidates = Array.from(values.values()).sort(function (a, b) {
      return a.distance - b.distance || a.y - b.y || a.x - b.x;
    });
    var truncated = candidates.length > cap;
    if (truncated) {
      var boundedCenterX = Math.max(bounds.minX, Math.min(bounds.maxX, element.centerX));
      var boundedCenterY = Math.max(bounds.minY, Math.min(bounds.maxY, element.centerY));
      var mandatory = [
        makeCandidate(element, boundedCenterX, bounds.minY, quantization),
        makeCandidate(element, boundedCenterX, bounds.maxY, quantization),
        makeCandidate(element, bounds.minX, boundedCenterY, quantization),
        makeCandidate(element, bounds.maxX, boundedCenterY, quantization),
        makeCandidate(element, bounds.minX, bounds.minY, quantization),
        makeCandidate(element, bounds.minX, bounds.maxY, quantization),
        makeCandidate(element, bounds.maxX, bounds.minY, quantization),
        makeCandidate(element, bounds.maxX, bounds.maxY, quantization),
      ];
      var mandatoryKeys = new Set(mandatory.map(function (candidate) { return candidate.x.toFixed(4) + '/' + candidate.y.toFixed(4); }));
      candidates = mandatory.concat(candidates.filter(function (candidate) {
        return !mandatoryKeys.has(candidate.x.toFixed(4) + '/' + candidate.y.toFixed(4));
      }).slice(0, Math.max(0, cap - mandatory.length)));
    }
    // 粗网格最近候选的 1s 邻域用于紧凑精化，不改变候选只平移的契约。
    var refined = new Map(candidates.map(function (candidate) { return [candidate.x.toFixed(4) + '/' + candidate.y.toFixed(4), candidate]; }));
    var anchors = candidates.slice(0, 32);
    for (var i = 0; i < anchors.length; i += 1) {
      for (var dx = -1; dx <= 1; dx += 1) for (var dy = -1; dy <= 1; dy += 1) {
        var x2 = anchors[i].x + dx * fine, y2 = anchors[i].y + dy * fine;
        if (x2 < bounds.minX || x2 > bounds.maxX || y2 < bounds.minY || y2 > bounds.maxY) continue;
        if (limit !== null && Math.hypot(x2 - element.centerX, y2 - element.centerY) > limit + EPS_RATIO) continue;
        var candidate = makeCandidate(element, x2, y2, quantization);
        refined.set(candidate.x.toFixed(4) + '/' + candidate.y.toFixed(4), candidate);
      }
    }
    candidates = Array.from(refined.values()).sort(function (a, b) { return a.distance - b.distance || a.y - b.y || a.x - b.x; });
    return { candidates: candidates, truncated: truncated };
  }

  function candidatesConflict(a, ca, b, cb, scale, epsilon) {
    var shared = [];
    for (var i = 0; i < a.frames.length; i += 1) {
      var other = b.frameMap.get(a.frames[i].frame);
      if (!other) continue;
      var ab = expanded(translateBox(a.frames[i].box, ca.x - a.centerX, ca.y - a.centerY), 4 * scale);
      var bb = expanded(translateBox(other.box, cb.x - b.centerX, cb.y - b.centerY), 4 * scale);
      if (intersects(ab, bb, epsilon)) shared.push(a.frames[i].frame);
    }
    return shared;
  }

  function solveAutoLayout(input) {
    var width = input.outputWidth, height = input.outputHeight;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || !Array.isArray(input.elements)) {
      return { status: 'error', message: '布局输出尺寸或元素无效', conflicts: [] };
    }
    var scale = scaleFor(width, height), epsilon = 0.01 * scale;
    var elements = normalizeElements(input);
    var fixedCandidate = function (element) { return { x: element.centerX, y: element.centerY, distance: 0 }; };
    var visibleFrameCount = elements.reduce(function (sum, element) { return sum + element.frames.length; }, 0);
    var movable = elements.filter(potentiallyMovable);
    if (!movable.length) {
      var fixedResult = {};
      elements.forEach(function (element) { fixedResult[element.id] = { centerXPct: rounded(element.centerX / width * 100), centerYPct: rounded(element.centerY / height * 100) }; });
      return { status: 'resolved', elements: fixedResult, metrics: { nodeCount: 0, frameCount: visibleFrameCount, digest: fnv1a(JSON.stringify(fixedResult)) } };
    }

    // 时间上不可能相撞的变量不必进入同一棵搜索树；固定元素作为各分量的共享障碍。
    if (!input.__partitioned) {
      var parents = movable.map(function (_, index) { return index; });
      function root(index) { while (parents[index] !== index) { parents[index] = parents[parents[index]]; index = parents[index]; } return index; }
      function join(a, b) { var ra = root(a), rb = root(b); if (ra !== rb) parents[rb] = ra; }
      for (var i = 0; i < movable.length; i += 1) for (var j = i + 1; j < movable.length; j += 1) {
        var sharesFrame = movable[i].frames.some(function (frame) { return movable[j].frameMap.has(frame.frame); });
        if (sharesFrame) join(i, j);
      }
      var groups = new Map();
      movable.forEach(function (element, index) {
        var key = root(index);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(element);
      });
      if (groups.size > 1) {
        var fixedSources = elements.filter(function (element) { return !potentiallyMovable(element); }).map(function (element) { return element.source; });
        var combined = {};
        var totalNodes = 0;
        var remainingNodes = Number.isSafeInteger(input.maxNodes) && input.maxNodes > 0 ? input.maxNodes : 20000;
        var components = Array.from(groups.values()).sort(function (a, b) { return a[0].id.localeCompare(b[0].id); });
        for (var g = 0; g < components.length; g += 1) {
          var subResult = solveAutoLayout({
            outputWidth: width, outputHeight: height, maxNodes: remainingNodes, __partitioned: true,
            elements: fixedSources.concat(components[g].map(function (element) { return element.source; })),
          });
          totalNodes += subResult.metrics ? subResult.metrics.nodeCount : 0;
          if (subResult.status !== 'resolved') return subResult;
          Object.assign(combined, subResult.elements);
          remainingNodes = Math.max(1, remainingNodes - (subResult.metrics ? subResult.metrics.nodeCount : 0));
        }
        return { status: 'resolved', elements: combined, metrics: { nodeCount: totalNodes, frameCount: visibleFrameCount, digest: fnv1a(JSON.stringify(combined)) } };
      }
    }

    var maxNodes = Number.isSafeInteger(input.maxNodes) && input.maxNodes > 0 ? input.maxNodes : 20000;
    var optimizationBudget = Number.isSafeInteger(input.optimizationNodes) && input.optimizationNodes >= 0 ? input.optimizationNodes : 64;
    var nodeCount = 0;
    var budgetStopped = false;
    var optimizationStopped = false;
    var bestNodeCount = -1;
    var best = null;
    var bestScore = null;
    var assigned = new Map();
    var deadEnds = [];
    var fixed = new Map();
    elements.forEach(function (element) { fixed.set(element.id, fixedCandidate(element)); });
    var conflictCache = new Map();
    function cachedConflict(a, ca, b, cb) {
      var swap = b.id < a.id;
      var left = swap ? b : a, right = swap ? a : b;
      var leftCandidate = swap ? cb : ca, rightCandidate = swap ? ca : cb;
      var key = left.id + ':' + leftCandidate.x.toFixed(4) + ',' + leftCandidate.y.toFixed(4)
        + '|' + right.id + ':' + rightCandidate.x.toFixed(4) + ',' + rightCandidate.y.toFixed(4);
      if (!conflictCache.has(key)) {
        if (conflictCache.size >= 100000) conflictCache.clear();
        conflictCache.set(key, candidatesConflict(left, leftCandidate, right, rightCandidate, scale, epsilon));
      }
      return conflictCache.get(key);
    }

    function candidateFor(element, index, domains) {
      return domains.get(element.id).candidates[index];
    }
    function conflictWithAssigned(element, candidate, variables) {
      for (var i = 0; i < elements.length; i += 1) {
        var other = elements[i];
        if (other.id === element.id) continue;
        var isVariable = variables.some(function (item) { return item.id === other.id; });
        var otherCandidate = assigned.get(other.id) || (!isVariable ? fixed.get(other.id) : null);
        if (!otherCandidate || (!potentiallyMovable(element) && !potentiallyMovable(other))) continue;
        if (cachedConflict(element, candidate, other, otherCandidate).length) return true;
      }
      return false;
    }
    function lowerBoundScore() {
      var maxDistance = 0, total = 0;
      assigned.forEach(function (candidate) { maxDistance = Math.max(maxDistance, candidate.distance); total += candidate.distance; });
      return { maxDistance: maxDistance, total: total };
    }
    function scoreBetter(score, other) {
      if (!other) return true;
      return score.maxDistance < other.maxDistance - EPS_RATIO
        || (Math.abs(score.maxDistance - other.maxDistance) <= EPS_RATIO && score.total < other.total - EPS_RATIO)
        || (Math.abs(score.maxDistance - other.maxDistance) <= EPS_RATIO && Math.abs(score.total - other.total) <= EPS_RATIO && score.orderPenalty < other.orderPenalty)
        || (Math.abs(score.maxDistance - other.maxDistance) <= EPS_RATIO && Math.abs(score.total - other.total) <= EPS_RATIO && score.orderPenalty === other.orderPenalty && score.tie < other.tie);
    }
    function completeScore() {
      var base = lowerBoundScore();
      var ordered = elements.filter(function (element) { return potentiallyMovable(element); }).slice().sort(function (a, b) { return a.order - b.order; });
      var penalty = 0;
      var previousY = -Infinity;
      for (var i = 0; i < ordered.length; i += 1) {
        var candidate = assigned.get(ordered[i].id) || fixed.get(ordered[i].id);
        if (candidate.y < previousY - epsilon) penalty += 1;
        previousY = Math.max(previousY, candidate.y);
      }
      var tie = ordered.map(function (element) { return element.id; }).join('|');
      return { maxDistance: base.maxDistance, total: base.total, orderPenalty: penalty, tie: tie };
    }
    function search(variables, domains) {
      if (budgetStopped || optimizationStopped) return;
      if (assigned.size === variables.length) {
        var score = completeScore();
        if (scoreBetter(score, bestScore)) {
          bestScore = score;
          best = new Map(assigned);
          if (bestNodeCount < 0) bestNodeCount = nodeCount;
          if ((score.maxDistance <= EPS_RATIO && score.total <= EPS_RATIO) || nodeCount - bestNodeCount >= optimizationBudget) optimizationStopped = true;
        }
        return;
      }
      var lower = lowerBoundScore();
      if (bestScore && (lower.maxDistance > bestScore.maxDistance + EPS_RATIO
        || (Math.abs(lower.maxDistance - bestScore.maxDistance) <= EPS_RATIO && lower.total > bestScore.total + EPS_RATIO))) return;
      var remaining = variables.filter(function (element) { return !assigned.has(element.id); });
      var chosen = null, chosenCandidates = null;
      for (var i = 0; i < remaining.length; i += 1) {
        var element = remaining[i];
        var valid = [];
        var domain = domains.get(element.id);
        for (var c = 0; c < domain.candidates.length; c += 1) {
          var candidate = domain.candidates[c];
          if (!conflictWithAssigned(element, candidate, variables)) valid.push(c);
        }
        if (!valid.length) {
          if (deadEnds.length < 5) {
            var assignedNow = Array.from(assigned.entries()).map(function ([id, candidate]) { return { id: id, x: candidate.x, y: candidate.y }; });
            var sampleCandidates = [domain.candidates[0], domain.candidates[domain.candidates.length - 1]];
            deadEnds.push({
              elementId: element.id,
              candidateCount: domain.candidates.length,
              candidateRange: {
                minX: Math.min.apply(null, domain.candidates.map(function (candidate) { return candidate.x; })),
                maxX: Math.max.apply(null, domain.candidates.map(function (candidate) { return candidate.x; })),
                minY: Math.min.apply(null, domain.candidates.map(function (candidate) { return candidate.y; })),
                maxY: Math.max.apply(null, domain.candidates.map(function (candidate) { return candidate.y; })),
              },
              assigned: assignedNow,
              sampleBlockers: assignedNow.map(function (item) {
                var other = elements.find(function (candidateElement) { return candidateElement.id === item.id; });
                return { id: item.id, frames: sampleCandidates.map(function (candidate) { return candidatesConflict(element, candidate, other, item, scale, epsilon).slice(0, 8); }) };
              }),
            });
          }
          return;
        }
        if (!chosen || valid.length < chosenCandidates.length || (valid.length === chosenCandidates.length && element.id < chosen.id)) {
          chosen = element; chosenCandidates = valid;
        }
      }
      var current = lowerBoundScore();
      for (var j = 0; j < chosenCandidates.length; j += 1) {
        if (nodeCount >= maxNodes) { budgetStopped = true; return; }
        var candidate = candidateFor(chosen, chosenCandidates[j], domains);
        var nextMax = Math.max(current.maxDistance, candidate.distance);
        var nextTotal = current.total + candidate.distance;
        if (bestScore && (nextMax > bestScore.maxDistance + EPS_RATIO
          || (Math.abs(nextMax - bestScore.maxDistance) <= EPS_RATIO && nextTotal > bestScore.total + EPS_RATIO))) continue;
        nodeCount += 1;
        assigned.set(chosen.id, candidate);
        search(variables, domains);
        assigned.delete(chosen.id);
        if (budgetStopped || optimizationStopped) return;
      }
    }

    function run(variables, domains) {
      assigned = new Map(); deadEnds = []; best = null; bestScore = null; budgetStopped = false; optimizationStopped = false; bestNodeCount = -1;
      search(variables, domains);
      return best;
    }
    function resolvedResult(solution, nodes) {
      var result = {};
      elements.forEach(function (element) {
        var candidate = solution.get(element.id) || fixed.get(element.id) || fixedCandidate(element);
        result[element.id] = { centerXPct: rounded(candidate.x / width * 100), centerYPct: rounded(candidate.y / height * 100) };
      });
      return { status: 'resolved', elements: result, metrics: { nodeCount: nodes, frameCount: visibleFrameCount, digest: fnv1a(JSON.stringify(result)) } };
    }
    function failure(domains) {
      var truncated = false;
      domains.forEach(function (domain) { truncated = truncated || domain.truncated; });
      var conflicts = [];
      for (var i = 0; i < elements.length; i += 1) {
        var element = elements[i];
        if (potentiallyMovable(element) && domains.get(element.id).candidates.length === 0) conflicts.push({ elementId: element.id, frames: element.frames.map(function (f) { return f.frame; }), reason: 'outside_safe_area' });
      }
      var domainDiagnostics = [];
      domains.forEach(function (domain, id) { domainDiagnostics.push({ elementId: id, candidateCount: domain.candidates.length, truncated: domain.truncated }); });
      return { status: budgetStopped || truncated ? 'budget_exceeded' : 'infeasible', conflicts: conflicts, diagnostics: { domains: domainDiagnostics, deadEnds: deadEnds }, metrics: { nodeCount: nodeCount, frameCount: visibleFrameCount } };
    }

    var stickers = elements.filter(movableSticker);
    var localDomains = new Map();
    stickers.forEach(function (element) { localDomains.set(element.id, domainFor(element, width, height, scale, 32 * scale)); });
    if (stickers.every(function (element) { return localDomains.get(element.id).candidates.length > 0; })) {
      var localSolution = run(stickers, localDomains);
      if (localSolution) {
        // 第一阶段仍需保证第二阶段卖点之间不存在遗留冲突；有则进入联合求解。
        var cueConflict = false;
        var cues = elements.filter(movableCue);
        for (var i = 0; i < cues.length && !cueConflict; i += 1) for (var j = i + 1; j < cues.length; j += 1) {
          if (cachedConflict(cues[i], fixedCandidate(cues[i]), cues[j], fixedCandidate(cues[j])).length) { cueConflict = true; break; }
        }
        // 提前返回不能只检查卖点重叠：当前位置本身越出上 40% 时，也必须进入联合求解。
        var cueOutsideSafeArea = cues.some(function (element) {
          var bounds = centerBounds(element, width, height);
          if (!bounds) return true;
          var candidate = fixedCandidate(element);
          return candidate.x < bounds.minX - EPS_RATIO || candidate.x > bounds.maxX + EPS_RATIO
            || candidate.y < bounds.minY - EPS_RATIO || candidate.y > bounds.maxY + EPS_RATIO;
        });
        if (!cueConflict && !cueOutsideSafeArea) return resolvedResult(localSolution, nodeCount);

        // 第二阶段固定第一阶段贴纸结果，只移动卖点；只有卖点单独无解时才进入全量联合求解。
        stickers.forEach(function (element) { fixed.set(element.id, localSolution.get(element.id) || fixedCandidate(element)); });
        var cueVariables = elements.filter(movableCue);
        var cueDomains = new Map();
        cueVariables.forEach(function (element) { cueDomains.set(element.id, domainFor(element, width, height, scale, null)); });
        if (cueVariables.every(function (element) { return cueDomains.get(element.id).candidates.length > 0; })) {
          var cueSolution = run(cueVariables, cueDomains);
          if (cueSolution) return resolvedResult(cueSolution, nodeCount);
        }
      }
    }

    nodeCount = 0;
    var variables = elements.filter(potentiallyMovable);
    var fullDomains = new Map();
    variables.forEach(function (element) { fullDomains.set(element.id, domainFor(element, width, height, scale, null)); });
    if (variables.some(function (element) { return fullDomains.get(element.id).candidates.length === 0; })) return failure(fullDomains);
    var solution = run(variables, fullDomains);
    if (solution) return resolvedResult(solution, nodeCount);
    return failure(fullDomains);
  }

  var api = {
    scaleFor: scaleFor,
    translateBox: translateBox,
    expanded: expanded,
    intersects: intersects,
    solveAutoLayout: solveAutoLayout,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (global) global.__packagingAutoLayoutRuntime = api;
})(typeof window !== 'undefined' ? window : null);
