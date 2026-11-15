/**
 * pipeline.js
 * Japan Inbound Rules 無人自動更新・クロスチェックパイプライン
 * 複数ソース間の事実照合・ハルシネーション及び誤情報混入の物理的防止
 */

const fs = require('fs');
const path = require('path');
const { RulesDatabase } = require('./rules_db');

/**
 * 2つ以上の独立したソース間で主要数値・事実が完全一致する場合のみ採用
 * 矛盾や不一致、またはソースが1つしかない場合は conflict_rejected として既存ルールを保護
 * 
 * @param {Object} existingRule - 既存のルールオブジェクト
 * @param {Array<Object>} candidateFacts - 複数ソースからの事実候補配列
 *   例: [
 *     { source: "https://www.nta.go.jp/...", facts: { min_jpy_ex_tax: 5000 } },
 *     { source: "https://www.mlit.go.jp/...", facts: { min_jpy_ex_tax: 5000 } }
 *   ]
 * @returns {Object} { status: 'updated' | 'conflict_rejected', reason: string, updatedRule?: Object, existingRule?: Object }
 */
function crossCheckFactUpdate(existingRule = {}, candidateFacts = []) {
  if (!Array.isArray(candidateFacts) || candidateFacts.length < 2) {
    return {
      status: 'conflict_rejected',
      reason: 'Rejected: Minimum 2 independent official sources are strictly required for cross-verification.',
      existingRule: { ...existingRule }
    };
  }

  // 独立ソースの検証（同一URL・同一ソースの重複を防止）
  const uniqueSources = new Set(candidateFacts.map(c => String(c.source || '').trim()).filter(Boolean));
  if (uniqueSources.size < 2) {
    return {
      status: 'conflict_rejected',
      reason: 'Rejected: Duplicate or invalid sources detected. Independent sources count must be at least 2.',
      existingRule: { ...existingRule }
    };
  }

  // 主要プロパティの突き合わせ検証
  const baseCandidate = candidateFacts[0];
  const baseFacts = baseCandidate.facts;
  if (!baseFacts || typeof baseFacts !== 'object' || Object.keys(baseFacts).length === 0) {
    return {
      status: 'conflict_rejected',
      reason: 'Rejected: No valid facts provided in candidate payload.',
      existingRule: { ...existingRule }
    };
  }

  const factKeys = Object.keys(baseFacts);

  for (let i = 1; i < candidateFacts.length; i++) {
    const targetFacts = candidateFacts[i].facts;
    if (!targetFacts || typeof targetFacts !== 'object') {
      return {
        status: 'conflict_rejected',
        reason: `Rejected: Candidate ${i} has invalid facts object.`,
        existingRule: { ...existingRule }
      };
    }

    for (const key of factKeys) {
      const baseVal = baseFacts[key];
      const targetVal = targetFacts[key];

      // 型と値の厳格一致確認
      if (typeof baseVal === 'object' && baseVal !== null) {
        if (JSON.stringify(baseVal) !== JSON.stringify(targetVal)) {
          return {
            status: 'conflict_rejected',
            reason: `Rejected: Fact conflict detected on key '${key}'. Values differ between sources: (${JSON.stringify(baseVal)} vs ${JSON.stringify(targetVal)}). Existing data preserved.`,
            existingRule: { ...existingRule }
          };
        }
      } else {
        if (baseVal !== targetVal) {
          return {
            status: 'conflict_rejected',
            reason: `Rejected: Fact conflict detected on key '${key}'. Values differ between sources: (${baseVal} vs ${targetVal}). Existing data preserved.`,
            existingRule: { ...existingRule }
          };
        }
      }
    }
  }

  // 全ソース間で事実が一致 -> 更新採用
  const verifiedAt = new Date().toISOString();
  const updatedRule = {
    ...existingRule,
    ...baseFacts,
    verified_at: verifiedAt,
    last_verified_sources: Array.from(uniqueSources)
  };

  return {
    status: 'updated',
    reason: `Accepted: Verified and corroborated by ${uniqueSources.size} independent sources.`,
    updatedRule,
    verifiedAt
  };
}

/**
 * 自動パイプライン巡回・更新実行
 * @param {Object} options
 * @param {Function} options.fetcherFn - 候補事実を収集する関数 () => Promise<Array<CandidateItem>>
 * @param {string} [options.dbPath] - 更新対象のDBパス
 * @returns {Promise<Object>} 更新結果サマリー
 */
async function runPipelineUpdate({ fetcherFn, dbPath } = {}) {
  if (typeof fetcherFn !== 'function') {
    throw new Error('fetcherFn must be a function returning candidate facts.');
  }

  const db = new RulesDatabase(dbPath);
  db.load();

  const candidateItems = await fetcherFn();
  if (!Array.isArray(candidateItems)) {
    throw new Error('fetcherFn must return an array of candidate rule items.');
  }

  let processedCount = 0;
  let updatedCount = 0;
  let rejectedCount = 0;
  const results = [];

  for (const item of candidateItems) {
    processedCount++;
    const { category, ruleId, candidateFacts } = item;
    const catObj = db.data.categories?.[category];

    if (!catObj || !Array.isArray(catObj.rules)) {
      results.push({
        ruleId,
        category,
        status: 'error',
        message: `Category '${category}' not found in database.`
      });
      continue;
    }

    const ruleIndex = catObj.rules.findIndex(r => r.id === ruleId);
    if (ruleIndex === -1) {
      results.push({
        ruleId,
        category,
        status: 'error',
        message: `Rule '${ruleId}' not found in category '${category}'.`
      });
      continue;
    }

    const existingRule = catObj.rules[ruleIndex];
    const checkResult = crossCheckFactUpdate(existingRule, candidateFacts);

    if (checkResult.status === 'updated') {
      catObj.rules[ruleIndex] = checkResult.updatedRule;
      catObj.last_verified_at = checkResult.verifiedAt;
      db.data.last_verified_at = checkResult.verifiedAt;
      updatedCount++;
    } else {
      rejectedCount++;
    }

    results.push({
      ruleId,
      category,
      status: checkResult.status,
      reason: checkResult.reason
    });
  }

  if (updatedCount > 0) {
    db.save();
  }

  return {
    success: true,
    processed_count: processedCount,
    updated_count: updatedCount,
    rejected_count: rejectedCount,
    results
  };
}

module.exports = {
  crossCheckFactUpdate,
  runPipelineUpdate
};
