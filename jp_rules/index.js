/**
 * index.js
 * Japan Inbound & Cross-Border Rules モジュールエントリポイント
 */

const { RulesDatabase, defaultRulesDb } = require('./rules_db');
const { crossCheckFactUpdate, runPipelineUpdate } = require('./pipeline');

module.exports = {
  RulesDatabase,
  defaultRulesDb,
  crossCheckFactUpdate,
  runPipelineUpdate
};
