/**
 * test_jp_rules_mcp.js
 * Japan Inbound & Cross-Border Rules MCP モジュール 包括的技術QAテスト
 * 
 * ゼロ外部依存・assert による厳格検証・テスト改ざん及びモック詐欺の物理的排除
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createMcpHandler } = require('./mcp');
const { createStoreServer } = require('./server');
const { StoreManager } = require('./store');
const { RulesDatabase } = require('./jp_rules/rules_db');
const { crossCheckFactUpdate, runPipelineUpdate } = require('./jp_rules/pipeline');

console.log("=================================================================");
console.log("  Japan Inbound & Cross-Border Rules MCP 包括的技術QAテスト");
console.log("=================================================================\n");

let passedTests = 0;
let totalTests = 0;

function runTest(testName, testFn) {
  totalTests++;
  try {
    testFn();
    console.log(`[PASS] ${testName}`);
    passedTests++;
  } catch (err) {
    console.error(`[FAIL] ${testName}`);
    console.error(`       Error: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  }
}

async function runAsyncTest(testName, testFn) {
  totalTests++;
  try {
    await testFn();
    console.log(`[PASS] ${testName}`);
    passedTests++;
  } catch (err) {
    console.error(`[FAIL] ${testName}`);
    console.error(`       Error: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  }
}

(async () => {
  // 一時テストデータディレクトリ
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'souon_jp_rules_test_'));
  const tempStorePath = path.join(tempDir, 'store.json');
  const tempDbPath = path.join(tempDir, 'seed_data.json');

  // seed_data.json をコピーして独立テスト用DBを作成
  const origSeedPath = path.resolve(__dirname, 'jp_rules', 'seed_data.json');
  fs.copyFileSync(origSeedPath, tempDbPath);

  const testStore = new StoreManager(tempStorePath);
  const mcpHandler = createMcpHandler(testStore);

  // テスト用APIキー発行（月額上限 300 JPY）
  const testKeyResult = testStore.createKey({ name: "Japan Inbound Rules QA Agent", monthly_limit_yen: 300 });
  const testApiKey = testKeyResult.key;

  // -------------------------------------------------------------
  // Test Group 1: tools/list スキーマおよび英語ファースト定義検証
  // -------------------------------------------------------------
  await runAsyncTest("01. tools/list に 3 つの新規ツールが存在し、英語ファーストスキーマであること", async () => {
    const res = await mcpHandler({
      jsonrpc: "2.0",
      id: "req_tools_list",
      method: "tools/list"
    });

    assert.strictEqual(res.jsonrpc, "2.0");
    assert.strictEqual(res.id, "req_tools_list");
    assert.ok(res.result && Array.isArray(res.result.tools));

    const tools = res.result.tools;
    const toolNames = tools.map(t => t.name);

    assert.ok(toolNames.includes("list_jp_rule_categories"), "list_jp_rule_categories missing");
    assert.ok(toolNames.includes("query_jp_inbound_rules"), "query_jp_inbound_rules missing");
    assert.ok(toolNames.includes("check_jp_travel_compliance"), "check_jp_travel_compliance missing");

    // 各ツールの説明が英語を含んでいること
    const catTool = tools.find(t => t.name === "list_jp_rule_categories");
    assert.ok(catTool.description.includes("Free 0 JPY") && catTool.description.includes("categories"), "list_jp_rule_categories description must be English-first / bilingual");

    const queryTool = tools.find(t => t.name === "query_jp_inbound_rules");
    assert.ok(queryTool.description.includes("Free 0 JPY") && queryTool.description.includes("Query official Japan inbound"), "query_jp_inbound_rules description must include Free 0 JPY and English");
    assert.ok(queryTool.inputSchema.properties.apiKey, "query_jp_inbound_rules must have apiKey property");
    assert.ok(queryTool.inputSchema.properties.category, "query_jp_inbound_rules must have category property");

    const checkTool = tools.find(t => t.name === "check_jp_travel_compliance");
    assert.ok(checkTool.description.includes("30 JPY") && checkTool.description.includes("compliance"), "check_jp_travel_compliance description must include 30 JPY and English");
    assert.deepStrictEqual(checkTool.inputSchema.required, ["checkType"], "checkType must be required");
  });

  // -------------------------------------------------------------
  // Test Group 2: list_jp_rule_categories 無料・APIキー不要動作検証
  // -------------------------------------------------------------
  await runAsyncTest("02. list_jp_rule_categories が apiKey なしで無料(0 JPY)動作すること", async () => {
    const res = await mcpHandler({
      jsonrpc: "2.0",
      id: "req_cat_free",
      method: "tools/call",
      params: {
        name: "list_jp_rule_categories",
        arguments: {}
      }
    });

    assert.strictEqual(res.jsonrpc, "2.0");
    assert.strictEqual(res.id, "req_cat_free");
    assert.ok(!res.result.isError, "Should not return error for free category list");
    assert.ok(res.result.content && res.result.content[0].type === "text");

    const data = JSON.parse(res.result.content[0].text);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.cost_yen, 0);
    assert.ok(data.total_categories >= 4, "Must contain at least 4 categories");

    const catIds = data.categories.map(c => c.id);
    assert.ok(catIds.includes("tax_free"), "tax_free category missing");
    assert.ok(catIds.includes("rail_luggage"), "rail_luggage category missing");
    assert.ok(catIds.includes("holidays"), "holidays category missing");
    assert.ok(catIds.includes("customs"), "customs category missing");

    // 各カテゴリのフィールド検証
    const taxCat = data.categories.find(c => c.id === "tax_free");
    assert.ok(taxCat.name.includes("Tax-Free"));
    assert.ok(taxCat.rule_count >= 1);
    assert.ok(taxCat.last_verified_at);
  });

  // -------------------------------------------------------------
  // Test Group 3: query_jp_inbound_rules 無料(0 JPY)・APIキー不要＆渡されても課金なし検証
  // -------------------------------------------------------------
  await runAsyncTest("03. query_jp_inbound_rules がキーなし・あり共に無料(0 JPY)で動作し、新免税制度(2026年11月施行)が返ること", async () => {
    // 1. APIキーなしでクエリ実行（完全無料・キー不要）
    const noKeyRes = await mcpHandler({
      jsonrpc: "2.0",
      id: "req_query_no_key",
      method: "tools/call",
      params: {
        name: "query_jp_inbound_rules",
        arguments: { category: "tax_free" }
      }
    });
    assert.strictEqual(noKeyRes.jsonrpc, "2.0");
    assert.ok(!noKeyRes.result.isError, "Query without API key must succeed freely");

    const freeData = JSON.parse(noKeyRes.result.content[0].text);
    assert.strictEqual(freeData.success, true);
    assert.strictEqual(freeData.cost_yen, 0, "Cost must be 0 JPY");
    assert.ok(freeData.rules && freeData.rules.length > 0);

    // 新免税制度（2026年11月1日改正）の検証
    const taxRule = freeData.rules.find(r => r.id === "tax_free_general");
    assert.ok(taxRule, "tax_free_general rule must exist");
    assert.strictEqual(taxRule.min_jpy_ex_tax, 5000, "min_jpy_ex_tax must be 5000");
    assert.strictEqual(taxRule.refund_method, "post_departure_customs_confirmation", "refund_method must be airport departure confirmation");
    assert.strictEqual(taxRule.consumables_cap_abolished, true, "consumables 500k cap must be abolished");
    assert.strictEqual(taxRule.sealed_bag_required, false, "sealed bag must not be required");
    assert.strictEqual(taxRule.departure_deadline_days, 90, "departure deadline must be 90 days");
    assert.strictEqual(taxRule.high_value_inspection_jpy, 1000000, "high value threshold must be 1,000,000 JPY");
    assert.strictEqual(taxRule.effective_date, "2026-11-01", "effective date must be 2026-11-01");

    // 2. APIキーありでクエリ実行しても課金されないこと (キー消費なし・残高維持)
    const initialUsage = testStore.getKeyUsage(testApiKey);
    assert.strictEqual(initialUsage.used_yen, 0, "Initial used_yen must be 0 JPY");

    const resWithKey = await mcpHandler({
      jsonrpc: "2.0",
      id: "req_query_with_key",
      method: "tools/call",
      params: {
        name: "query_jp_inbound_rules",
        arguments: {
          apiKey: testApiKey,
          category: "tax_free"
        }
      }
    });

    assert.strictEqual(resWithKey.jsonrpc, "2.0");
    assert.ok(!resWithKey.result.isError, "Query with key must succeed");
    const dataWithKey = JSON.parse(resWithKey.result.content[0].text);
    assert.strictEqual(dataWithKey.success, true);
    assert.strictEqual(dataWithKey.cost_yen, 0, "Cost must be 0 JPY even when key is provided");

    const usageAfterKeyQuery = testStore.getKeyUsage(testApiKey);
    assert.strictEqual(usageAfterKeyQuery.used_yen, 0, "Key used_yen must remain 0 JPY (no charge for query)");
    assert.strictEqual(usageAfterKeyQuery.remaining_yen, 300, "Key remaining_yen must remain 300 JPY");

    // 3. キーワード検索検証 (APIキーありでも課金0円)
    const kwRes = await mcpHandler({
      jsonrpc: "2.0",
      id: "req_query_keyword",
      method: "tools/call",
      params: {
        name: "query_jp_inbound_rules",
        arguments: {
          apiKey: testApiKey,
          keyword: "oversized"
        }
      }
    });
    const kwData = JSON.parse(kwRes.result.content[0].text);
    assert.strictEqual(kwData.success, true);
    assert.strictEqual(kwData.cost_yen, 0);
    assert.ok(kwData.rules.some(r => r.id === "shinkansen_baggage_limits"), "Should find shinkansen baggage rule by keyword 'oversized'");

    const finalUsage = testStore.getKeyUsage(testApiKey);
    assert.strictEqual(finalUsage.used_yen, 0, "Key used_yen must still be 0 JPY");
  });

  // -------------------------------------------------------------
  // Test Group 4: check_jp_travel_compliance 3モード即決判定検証
  // -------------------------------------------------------------
  await runAsyncTest("04-1. check_jp_travel_compliance: tax_free モード (4500 / 5000 / 1000000 JPY) ＆ 30 JPY課金検証", async () => {
    // 4500 JPY (免税対象外)
    const res4500 = await mcpHandler({
      jsonrpc: "2.0",
      id: "req_check_tf_4500",
      method: "tools/call",
      params: {
        name: "check_jp_travel_compliance",
        arguments: {
          apiKey: testApiKey,
          checkType: "tax_free",
          purchaseAmountJpy: 4500
        }
      }
    });
    const data4500 = JSON.parse(res4500.result.content[0].text);
    assert.strictEqual(data4500.success, true);
    assert.strictEqual(data4500.cost_yen, 30, "Compliance check must cost 30 JPY");
    assert.strictEqual(data4500.used_yen, 30, "Used yen must be 30 JPY after 1st check");
    assert.strictEqual(data4500.remaining_yen, 270, "Remaining yen must be 270 JPY (300 - 30)");
    assert.strictEqual(data4500.compliance.eligible, false, "4500 JPY should not be eligible (< 5000 JPY)");
    assert.strictEqual(data4500.compliance.high_value_inspection_likely, false);
    assert.strictEqual(data4500.compliance.min_jpy_ex_tax, 5000);
    assert.strictEqual(data4500.compliance.refund_method, "post_departure_customs_confirmation");

    // 5000 JPY (免税対象、高額検査なし)
    const res5000 = await mcpHandler({
      jsonrpc: "2.0",
      id: "req_check_tf_5000",
      method: "tools/call",
      params: {
        name: "check_jp_travel_compliance",
        arguments: {
          apiKey: testApiKey,
          checkType: "tax_free",
          purchaseAmountJpy: 5000
        }
      }
    });
    const data5000 = JSON.parse(res5000.result.content[0].text);
    assert.strictEqual(data5000.success, true);
    assert.strictEqual(data5000.cost_yen, 30, "Compliance check must cost 30 JPY");
    assert.strictEqual(data5000.used_yen, 60, "Used yen must be 60 JPY after 2nd check");
    assert.strictEqual(data5000.remaining_yen, 240, "Remaining yen must be 240 JPY (300 - 60)");
    assert.strictEqual(data5000.compliance.eligible, true, "5000 JPY should be eligible (>= 5000 JPY)");
    assert.strictEqual(data5000.compliance.high_value_inspection_likely, false);

    // 1000000 JPY (免税対象、高額品税関現物検査必須)
    const res1M = await mcpHandler({
      jsonrpc: "2.0",
      id: "req_check_tf_1M",
      method: "tools/call",
      params: {
        name: "check_jp_travel_compliance",
        arguments: {
          apiKey: testApiKey,
          checkType: "tax_free",
          purchaseAmountJpy: 1000000
        }
      }
    });
    const data1M = JSON.parse(res1M.result.content[0].text);
    assert.strictEqual(data1M.success, true);
    assert.strictEqual(data1M.cost_yen, 30, "Compliance check must cost 30 JPY");
    assert.strictEqual(data1M.used_yen, 90, "Used yen must be 90 JPY after 3rd check");
    assert.strictEqual(data1M.remaining_yen, 210, "Remaining yen must be 210 JPY (300 - 90)");
    assert.strictEqual(data1M.compliance.eligible, true);
    assert.strictEqual(data1M.compliance.high_value_inspection_likely, true, ">= 1M JPY must trigger mandatory inspection");
  });

  await runAsyncTest("04-2. check_jp_travel_compliance: shinkansen_baggage モード (150 / 165 / 260 cm)", async () => {
    // 150 cm: 予約不要
    const res150 = await mcpHandler({
      jsonrpc: "2.0",
      id: "req_check_bag_150",
      method: "tools/call",
      params: {
        name: "check_jp_travel_compliance",
        arguments: {
          apiKey: testApiKey,
          checkType: "shinkansen_baggage",
          baggageTotalCm: 150
        }
      }
    });
    const data150 = JSON.parse(res150.result.content[0].text);
    assert.strictEqual(data150.compliance.allowed, true);
    assert.strictEqual(data150.compliance.requires_reservation, false);
    assert.strictEqual(data150.compliance.unreserved_penalty_jpy, 0);
    assert.ok(data150.compliance.size_category.includes("standard"));

    // 165 cm: 事前予約必須、未予約持込時は1000 JPYペナルティ
    const res165 = await mcpHandler({
      jsonrpc: "2.0",
      id: "req_check_bag_165",
      method: "tools/call",
      params: {
        name: "check_jp_travel_compliance",
        arguments: {
          apiKey: testApiKey,
          checkType: "shinkansen_baggage",
          baggageTotalCm: 165
        }
      }
    });
    const data165 = JSON.parse(res165.result.content[0].text);
    assert.strictEqual(data165.compliance.allowed, true);
    assert.strictEqual(data165.compliance.requires_reservation, true);
    assert.strictEqual(data165.compliance.unreserved_penalty_jpy, 1000);
    assert.ok(data165.compliance.size_category.includes("oversized"));

    // 260 cm: 持込不可 (> 250 cm)
    const res260 = await mcpHandler({
      jsonrpc: "2.0",
      id: "req_check_bag_260",
      method: "tools/call",
      params: {
        name: "check_jp_travel_compliance",
        arguments: {
          apiKey: testApiKey,
          checkType: "shinkansen_baggage",
          baggageTotalCm: 260
        }
      }
    });
    const data260 = JSON.parse(res260.result.content[0].text);
    assert.strictEqual(data260.compliance.allowed, false);
    assert.ok(data260.compliance.size_category.includes("prohibited"));
  });

  await runAsyncTest("04-3. check_jp_travel_compliance: holiday_peak モード (2026-05-03 GW / 通常日)", async () => {
    // 2026-05-03: ゴールデンウィーク
    const resGw = await mcpHandler({
      jsonrpc: "2.0",
      id: "req_check_gw",
      method: "tools/call",
      params: {
        name: "check_jp_travel_compliance",
        arguments: {
          apiKey: testApiKey,
          checkType: "holiday_peak",
          travelDate: "2026-05-03"
        }
      }
    });
    const dataGw = JSON.parse(resGw.result.content[0].text);
    assert.strictEqual(dataGw.compliance.is_peak, true, "2026-05-03 must be peak season");
    assert.strictEqual(dataGw.compliance.period_name, "Golden Week");
    assert.strictEqual(dataGw.compliance.risk_level, "high");

    // 2026-06-10: 通常日
    const resReg = await mcpHandler({
      jsonrpc: "2.0",
      id: "req_check_regular",
      method: "tools/call",
      params: {
        name: "check_jp_travel_compliance",
        arguments: {
          apiKey: testApiKey,
          checkType: "holiday_peak",
          travelDate: "2026-06-10"
        }
      }
    });
    const dataReg = JSON.parse(resReg.result.content[0].text);
    assert.strictEqual(dataReg.compliance.is_peak, false, "2026-06-10 must be regular period");
    assert.strictEqual(dataReg.compliance.period_name, "Regular Period");
    assert.strictEqual(dataReg.compliance.risk_level, "low");
  });

  // -------------------------------------------------------------
  // Test Group 5: 月額上限到達時の 402 LIMIT_EXCEEDED 拒否と残高保護
  // -------------------------------------------------------------
  await runAsyncTest("05. お小遣い上限到達時の 402 LIMIT_EXCEEDED 拒否と残高保護", async () => {
    // 上限35円のキーで、1回目30円消費 -> 残高5円にし、2回目30円要求で402拒否されるシナリオ
    const tightKeyResult = testStore.createKey({ name: "Tight Budget Agent", monthly_limit_yen: 35 });
    const tightApiKey = tightKeyResult.key;

    // 1回目 (check_jp_travel_compliance で 30円消費 -> 残高5円)
    const call1 = await mcpHandler({
      jsonrpc: "2.0",
      id: "req_tight_1",
      method: "tools/call",
      params: {
        name: "check_jp_travel_compliance",
        arguments: {
          apiKey: tightApiKey,
          checkType: "shinkansen_baggage",
          baggageTotalCm: 150
        }
      }
    });
    const data1 = JSON.parse(call1.result.content[0].text);
    assert.strictEqual(data1.success, true);
    assert.strictEqual(data1.cost_yen, 30);
    assert.strictEqual(data1.used_yen, 30);
    assert.strictEqual(data1.remaining_yen, 5);

    // 2回目 (30円必要だが残高5円 -> 402 LIMIT_EXCEEDED で拒否)
    const call2 = await mcpHandler({
      jsonrpc: "2.0",
      id: "req_tight_2",
      method: "tools/call",
      params: {
        name: "check_jp_travel_compliance",
        arguments: {
          apiKey: tightApiKey,
          checkType: "tax_free",
          purchaseAmountJpy: 10000
        }
      }
    });

    assert.strictEqual(call2.result.isError, true, "Must return isError: true on limit exceeded");
    const errData = JSON.parse(call2.result.content[0].text);
    assert.strictEqual(errData.error, "LIMIT_EXCEEDED");
    assert.strictEqual(errData.statusCode, 402);
    assert.strictEqual(errData.monthly_limit_yen, 35);
    assert.strictEqual(errData.used_yen, 30, "Used amount must NOT increase");
    assert.strictEqual(errData.remaining_yen, 5, "Remaining balance must be protected and unchanged");

    // キーの利用状況を再照会して残高保護を直接検証
    const usage = testStore.getKeyUsage(tightApiKey);
    assert.strictEqual(usage.used_yen, 30, "Persisted used_yen must remain 30 JPY");
    assert.strictEqual(usage.remaining_yen, 5, "Persisted remaining_yen must remain 5 JPY");

    // 3回目: 上限到達キーであっても、無料の query_jp_inbound_rules は 0 JPY で成功し残高5円が保護されること
    const callFree = await mcpHandler({
      jsonrpc: "2.0",
      id: "req_tight_free_query",
      method: "tools/call",
      params: {
        name: "query_jp_inbound_rules",
        arguments: {
          apiKey: tightApiKey,
          category: "customs"
        }
      }
    });
    const dataFree = JSON.parse(callFree.result.content[0].text);
    assert.strictEqual(dataFree.success, true);
    assert.strictEqual(dataFree.cost_yen, 0);

    const usageAfterFree = testStore.getKeyUsage(tightApiKey);
    assert.strictEqual(usageAfterFree.used_yen, 30, "Free query must not alter used_yen");
    assert.strictEqual(usageAfterFree.remaining_yen, 5, "Free query must not alter remaining_yen");
  });

  // -------------------------------------------------------------
  // Test Group 6: pipeline.js のクロスチェック検証
  // -------------------------------------------------------------
  runTest("06-1. crossCheckFactUpdate: 2ソース完全一致で更新成功 (status: 'updated')", () => {
    const existingRule = {
      id: "test_rule",
      min_jpy_ex_tax: 5000,
      verified_at: "2026-01-01T00:00:00Z"
    };

    const candidateFacts = [
      {
        source: "https://www.nta.go.jp/official_notice_2026",
        facts: {
          min_jpy_ex_tax: 5000,
          high_value_inspection_jpy: 1000000
        }
      },
      {
        source: "https://www.mlit.go.jp/kankocho/official_press",
        facts: {
          min_jpy_ex_tax: 5000,
          high_value_inspection_jpy: 1000000
        }
      }
    ];

    const result = crossCheckFactUpdate(existingRule, candidateFacts);
    assert.strictEqual(result.status, "updated");
    assert.strictEqual(result.updatedRule.min_jpy_ex_tax, 5000);
    assert.strictEqual(result.updatedRule.high_value_inspection_jpy, 1000000);
    assert.ok(result.updatedRule.verified_at);
    assert.strictEqual(result.updatedRule.last_verified_sources.length, 2);
  });

  runTest("06-2. crossCheckFactUpdate: ソース間矛盾時に conflict_rejected で既存DB保護", () => {
    const existingRule = {
      id: "test_rule",
      min_jpy_ex_tax: 5000,
      protected_value: "DO_NOT_TOUCH"
    };

    // ソースAは5000、ソースBは6000で矛盾
    const conflictingCandidateFacts = [
      {
        source: "https://www.nta.go.jp/source_a",
        facts: { min_jpy_ex_tax: 5000 }
      },
      {
        source: "https://unverified-travel-blog.com/source_b",
        facts: { min_jpy_ex_tax: 6000 }
      }
    ];

    const result = crossCheckFactUpdate(existingRule, conflictingCandidateFacts);
    assert.strictEqual(result.status, "conflict_rejected");
    assert.ok(result.reason.includes("conflict detected"));
    assert.strictEqual(result.existingRule.min_jpy_ex_tax, 5000);
    assert.strictEqual(result.existingRule.protected_value, "DO_NOT_TOUCH");
  });

  runTest("06-3. crossCheckFactUpdate: 独立ソース不足（1件のみ / 同一URL重複）で拒否", () => {
    const existingRule = { id: "test_rule" };

    // 1件のみ
    const singleSource = [
      { source: "https://www.nta.go.jp", facts: { min: 5000 } }
    ];
    const resSingle = crossCheckFactUpdate(existingRule, singleSource);
    assert.strictEqual(resSingle.status, "conflict_rejected");

    // 同一URLの重複
    const duplicateSource = [
      { source: "https://www.nta.go.jp", facts: { min: 5000 } },
      { source: "https://www.nta.go.jp", facts: { min: 5000 } }
    ];
    const resDup = crossCheckFactUpdate(existingRule, duplicateSource);
    assert.strictEqual(resDup.status, "conflict_rejected");
  });

  await runAsyncTest("06-4. runPipelineUpdate: 実DB自動巡回・クロスチェック・差分更新・保護検証", async () => {
    // 成功パターン
    const successFetcher = async () => [
      {
        category: "tax_free",
        ruleId: "tax_free_general",
        candidateFacts: [
          { source: "https://www.nta.go.jp/taxfree_2026", facts: { min_jpy_ex_tax: 5000, departure_deadline_days: 90 } },
          { source: "https://www.customs.go.jp/taxfree_2026", facts: { min_jpy_ex_tax: 5000, departure_deadline_days: 90 } }
        ]
      }
    ];

    const pipelineRes1 = await runPipelineUpdate({
      fetcherFn: successFetcher,
      dbPath: tempDbPath
    });

    assert.strictEqual(pipelineRes1.success, true);
    assert.strictEqual(pipelineRes1.processed_count, 1);
    assert.strictEqual(pipelineRes1.updated_count, 1);
    assert.strictEqual(pipelineRes1.rejected_count, 0);

    // 矛盾パターン（既存データ破壊防止）
    const conflictingFetcher = async () => [
      {
        category: "rail_luggage",
        ruleId: "shinkansen_baggage_limits",
        candidateFacts: [
          { source: "https://jr-central.co.jp/source1", facts: { unreserved_penalty_jpy: 1000 } },
          { source: "https://unverified.com/source2", facts: { unreserved_penalty_jpy: 9999 } }
        ]
      }
    ];

    const pipelineRes2 = await runPipelineUpdate({
      fetcherFn: conflictingFetcher,
      dbPath: tempDbPath
    });

    assert.strictEqual(pipelineRes2.success, true);
    assert.strictEqual(pipelineRes2.processed_count, 1);
    assert.strictEqual(pipelineRes2.updated_count, 0);
    assert.strictEqual(pipelineRes2.rejected_count, 1);

    // 既存DBファイルの中身が保護されていることを確認
    const db = new RulesDatabase(tempDbPath);
    const rule = db.queryRules({ category: "rail_luggage" }).rules[0];
    assert.strictEqual(rule.unreserved_penalty_jpy, 1000, "Must retain original value of 1000 JPY");
  });

  // -------------------------------------------------------------
  // Test Group 7: MCP ディレクトリ掲載 & HTTP 互換性検証
  // -------------------------------------------------------------
  function dispatchTestRequest(handler, options = {}) {
    const { method = 'GET', url = '/', headers = {}, body = null } = options;
    return new Promise((resolve, reject) => {
      const EventEmitter = require('events');
      const req = new EventEmitter();
      req.method = method;
      req.url = url;
      req.headers = {};
      for (const [k, v] of Object.entries(headers)) {
        req.headers[k.toLowerCase()] = v;
      }
      let resStatusCode = 200;
      const resHeaders = {};
      const chunks = [];
      const res = {
        writeHead(code, hdrs) {
          resStatusCode = code;
          if (hdrs) {
            for (const [k, v] of Object.entries(hdrs)) {
              resHeaders[k.toLowerCase()] = v;
            }
          }
        },
        setHeader(name, val) { resHeaders[name.toLowerCase()] = val; },
        getHeader(name) { return resHeaders[name.toLowerCase()]; },
        write(chunk) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); },
        end(chunk) {
          if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          const fullBuffer = Buffer.concat(chunks);
          const text = fullBuffer.toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (e) { json = text; }
          resolve({
            statusCode: resStatusCode,
            headers: resHeaders,
            body: json,
            rawBody: text,
            rawBuffer: fullBuffer
          });
        }
      };
      handler(req, res).catch(reject);
      process.nextTick(() => {
        if (body !== null && body !== undefined) {
          const payload = (typeof body === 'object' && !Buffer.isBuffer(body)) ? JSON.stringify(body) : body;
          req.emit('data', payload);
        }
        req.emit('end');
      });
    });
  }

  const httpStoreServer = createStoreServer({ storePath: tempStorePath });
  const httpReq = (opts, body) => dispatchTestRequest(httpStoreServer.handleHttpRequest, { ...opts, body });

  await runAsyncTest("07-1. POST /mcp で x-api-key による check 課金(30 JPY)と query 無料(0 JPY)動作が通ること", async () => {
    const prevUsed = testStore.getKeyUsage(testApiKey).used_yen;

    // 1. check_jp_travel_compliance (30 JPY 課金)
    const resCheck = await httpReq({
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': testApiKey
      }
    }, {
      jsonrpc: "2.0",
      id: "req_via_x_api_key_check",
      method: "tools/call",
      params: {
        name: "check_jp_travel_compliance",
        arguments: {
          checkType: "holiday_peak",
          travelDate: "2026-05-03"
        }
      }
    });

    assert.strictEqual(resCheck.statusCode, 200);
    assert.ok(resCheck.body.result && !resCheck.body.result.isError, "Compliance check via x-api-key must succeed");
    const checkData = JSON.parse(resCheck.body.result.content[0].text);
    assert.strictEqual(checkData.success, true);
    assert.strictEqual(checkData.cost_yen, 30, "Compliance check cost must be 30 JPY");

    const usedAfterCheck = testStore.getKeyUsage(testApiKey).used_yen;
    assert.strictEqual(usedAfterCheck, prevUsed + 30, "Must charge 30 JPY on testApiKey via x-api-key header");

    // 2. query_jp_inbound_rules (x-api-key ヘッダーがあっても無料 0 JPY)
    const resQuery = await httpReq({
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': testApiKey
      }
    }, {
      jsonrpc: "2.0",
      id: "req_via_x_api_key_query",
      method: "tools/call",
      params: {
        name: "query_jp_inbound_rules",
        arguments: {
          category: "tax_free"
        }
      }
    });

    assert.strictEqual(resQuery.statusCode, 200);
    assert.ok(resQuery.body.result && !resQuery.body.result.isError, "Query via x-api-key must succeed");
    const queryData = JSON.parse(resQuery.body.result.content[0].text);
    assert.strictEqual(queryData.success, true);
    assert.strictEqual(queryData.cost_yen, 0, "Query cost must be 0 JPY");

    const usedAfterQuery = testStore.getKeyUsage(testApiKey).used_yen;
    assert.strictEqual(usedAfterQuery, usedAfterCheck, "Query must not increase used_yen (remains same)");

    // 3. query_jp_inbound_rules (x-api-key ヘッダーなしでも無料 0 JPY で成功)
    const resNoKey = await httpReq({
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json'
      }
    }, {
      jsonrpc: "2.0",
      id: "req_no_key_query",
      method: "tools/call",
      params: {
        name: "query_jp_inbound_rules",
        arguments: {
          category: "customs"
        }
      }
    });

    assert.strictEqual(resNoKey.statusCode, 200);
    assert.ok(resNoKey.body.result && !resNoKey.body.result.isError, "Query without header must succeed");
    const noKeyData = JSON.parse(resNoKey.body.result.content[0].text);
    assert.strictEqual(noKeyData.success, true);
    assert.strictEqual(noKeyData.cost_yen, 0);
  });

  await runAsyncTest("07-2. GET /mcp が 405 Method Not Allowed と Allow: POST, OPTIONS ヘッダーを返すこと", async () => {
    const res = await httpReq({ method: 'GET', url: '/mcp' });
    assert.strictEqual(res.statusCode, 405);
    assert.strictEqual(res.headers['allow'], 'POST, OPTIONS');
    assert.strictEqual(res.body.error, 'METHOD_NOT_ALLOWED');
    assert.strictEqual(res.body.endpoint, '/mcp');
  });

  await runAsyncTest("07-3. GET /.well-known/mcp.json と GET /server.json が 200 で有効な公開メタデータを返すこと", async () => {
    // 1. /.well-known/mcp.json
    const resWellKnown = await httpReq({ method: 'GET', url: '/.well-known/mcp.json' });
    assert.strictEqual(resWellKnown.statusCode, 200);
    assert.strictEqual(resWellKnown.body.name, "io.github.toymachine325-blip/jp-rules-mcp");
    assert.ok(Array.isArray(resWellKnown.body.remotes));
    assert.strictEqual(resWellKnown.body.remotes[0].url, "https://jp-rules-mcp.onrender.com/mcp");

    // 2. /server.json
    const resServerJson = await httpReq({ method: 'GET', url: '/server.json' });
    assert.strictEqual(resServerJson.statusCode, 200);
    assert.strictEqual(resServerJson.body.name, "io.github.toymachine325-blip/jp-rules-mcp");
    assert.ok(Array.isArray(resServerJson.body.remotes));
    assert.strictEqual(resServerJson.body.remotes[0].url, "https://jp-rules-mcp.onrender.com/mcp");
  });

  // -------------------------------------------------------------
  // Test Group 8: 無料リクエストの IP レート制限検証 (POST /mcp)
  // -------------------------------------------------------------
  const rateLimitServer = createStoreServer({
    storePath: tempStorePath,
    rateLimitMaxRequests: 3,
    rateLimitWindowMs: 60000
  });
  const rlReq = (opts, body) => dispatchTestRequest(rateLimitServer.handleHttpRequest, { ...opts, body });

  await runAsyncTest("08-1. 無料（APIキー無し）で上限以内は 200 OK で成功すること", async () => {
    for (let i = 1; i <= 3; i++) {
      const res = await rlReq({
        method: 'POST',
        url: '/mcp',
        headers: {
          'Content-Type': 'application/json',
          'x-forwarded-for': '203.0.113.1'
        }
      }, {
        jsonrpc: "2.0",
        id: `free_req_${i}`,
        method: "tools/call",
        params: {
          name: "list_jp_rule_categories",
          arguments: {}
        }
      });

      assert.strictEqual(res.statusCode, 200, `Request #${i} within rate limit must be 200 OK`);
      assert.ok(res.body.result && !res.body.result.isError, `Request #${i} must succeed`);
    }
  });

  await runAsyncTest("08-2. 上限超過で HTTP 429、Retry-After ヘッダ、エラーコード -32029 が返ること", async () => {
    // 4回目（上限3回を超過）
    const res = await rlReq({
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '203.0.113.1'
      }
    }, {
      jsonrpc: "2.0",
      id: "req_rate_limit_exceeded",
      method: "tools/call",
      params: {
        name: "list_jp_rule_categories",
        arguments: {}
      }
    });

    assert.strictEqual(res.statusCode, 429, "Exceeded request must return HTTP 429");
    assert.ok(res.headers['retry-after'], "Must contain Retry-After header");
    const retryAfter = parseInt(res.headers['retry-after'], 10);
    assert.ok(!isNaN(retryAfter) && retryAfter >= 1, "Retry-After must be integer >= 1");

    assert.strictEqual(res.body.jsonrpc, "2.0");
    assert.strictEqual(res.body.id, "req_rate_limit_exceeded");
    assert.ok(res.body.error, "Must contain JSON-RPC error");
    assert.strictEqual(res.body.error.code, -32029);
    assert.ok(res.body.error.message.includes("Free tier rate limit exceeded"), "Message must explain free tier limit");
    assert.ok(res.body.error.message.includes("Get an API key"), "Message must guide to API key");
  });

  await runAsyncTest("08-3. 別の x-forwarded-for IP からのリクエストは影響を受けず 200 OK になること", async () => {
    // 別IP（198.51.100.2）からのリクエスト
    const res = await rlReq({
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '198.51.100.2, 10.0.0.1' // カンマ区切りのテストも兼ねる
      }
    }, {
      jsonrpc: "2.0",
      id: "other_ip_req",
      method: "tools/call",
      params: {
        name: "list_jp_rule_categories",
        arguments: {}
      }
    });

    assert.strictEqual(res.statusCode, 200, "Request from distinct IP must not be throttled");
    assert.ok(res.body.result && !res.body.result.isError);
  });

  await runAsyncTest("08-4. x-api-key ヘッダありのリクエストはレート制限に引っかからず通過すること", async () => {
    // 既に無料上限超過している IP（203.0.113.1）から、x-api-key ありでリクエスト
    const res = await rlReq({
      method: 'POST',
      url: '/mcp',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '203.0.113.1',
        'x-api-key': testApiKey
      }
    }, {
      jsonrpc: "2.0",
      id: "auth_key_bypass_req",
      method: "tools/call",
      params: {
        name: "list_jp_rule_categories",
        arguments: {}
      }
    });

    assert.strictEqual(res.statusCode, 200, "Request with x-api-key must bypass free rate limit");
    assert.ok(res.body.result && !res.body.result.isError);
  });

  // -------------------------------------------------------------
  // Test Group 9: JP_RULES_FREE_BETA=true 完全無料パブリックベータ検証
  // -------------------------------------------------------------
  await runAsyncTest("09-1. JP_RULES_FREE_BETA=true で GET /health が free_beta: true を返すこと", async () => {
    const prevEnv = process.env.JP_RULES_FREE_BETA;
    try {
      process.env.JP_RULES_FREE_BETA = 'true';
      const betaServer = createStoreServer({ storePath: tempStorePath });
      const res = await dispatchTestRequest(betaServer.handleHttpRequest, { method: 'GET', url: '/health' });
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.status, 'ok');
      assert.strictEqual(res.body.free_beta, true, "health endpoint must report free_beta: true");
    } finally {
      if (prevEnv !== undefined) {
        process.env.JP_RULES_FREE_BETA = prevEnv;
      } else {
        delete process.env.JP_RULES_FREE_BETA;
      }
    }
  });

  await runAsyncTest("09-2. JP_RULES_FREE_BETA=true で check_jp_travel_compliance が APIキー無し・0 JPY・free_beta: true で成功すること", async () => {
    const prevEnv = process.env.JP_RULES_FREE_BETA;
    try {
      process.env.JP_RULES_FREE_BETA = 'true';
      const betaServer = createStoreServer({ storePath: tempStorePath });

      // APIキー無しで check_jp_travel_compliance を POST /mcp 経由で実行
      const res = await dispatchTestRequest(betaServer.handleHttpRequest, {
        method: 'POST',
        url: '/mcp',
        headers: { 'Content-Type': 'application/json' },
        body: {
          jsonrpc: "2.0",
          id: "req_free_beta_check",
          method: "tools/call",
          params: {
            name: "check_jp_travel_compliance",
            arguments: {
              checkType: "tax_free",
              purchaseAmountJpy: 8000
            }
          }
        }
      });

      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.body.result && !res.body.result.isError, "Call without API key in free beta must succeed");
      const data = JSON.parse(res.body.result.content[0].text);
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.cost_yen, 0, "Cost must be 0 JPY in free beta");
      assert.strictEqual(data.free_beta, true, "Must flag free_beta: true in response");
      assert.strictEqual(data.compliance.eligible, true);
    } finally {
      if (prevEnv !== undefined) {
        process.env.JP_RULES_FREE_BETA = prevEnv;
      } else {
        delete process.env.JP_RULES_FREE_BETA;
      }
    }
  });

  await runAsyncTest("09-3. JP_RULES_FREE_BETA=true 時でも IP レート制限（1分30回）が無料 check に正しく効くこと", async () => {
    const prevEnv = process.env.JP_RULES_FREE_BETA;
    try {
      process.env.JP_RULES_FREE_BETA = 'true';
      const betaThrottledServer = createStoreServer({
        storePath: tempStorePath,
        rateLimitMaxRequests: 2,
        rateLimitWindowMs: 60000
      });

      const clientIp = '198.51.100.99';

      // 1回目 (200 OK)
      const res1 = await dispatchTestRequest(betaThrottledServer.handleHttpRequest, {
        method: 'POST',
        url: '/mcp',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp },
        body: {
          jsonrpc: "2.0",
          id: "beta_req_1",
          method: "tools/call",
          params: {
            name: "check_jp_travel_compliance",
            arguments: { checkType: "shinkansen_baggage", baggageTotalCm: 150 }
          }
        }
      });
      assert.strictEqual(res1.statusCode, 200);

      // 2回目 (200 OK)
      const res2 = await dispatchTestRequest(betaThrottledServer.handleHttpRequest, {
        method: 'POST',
        url: '/mcp',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp },
        body: {
          jsonrpc: "2.0",
          id: "beta_req_2",
          method: "tools/call",
          params: {
            name: "check_jp_travel_compliance",
            arguments: { checkType: "shinkansen_baggage", baggageTotalCm: 150 }
          }
        }
      });
      assert.strictEqual(res2.statusCode, 200);

      // 3回目 (上限超過 -> 429)
      const res3 = await dispatchTestRequest(betaThrottledServer.handleHttpRequest, {
        method: 'POST',
        url: '/mcp',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': clientIp },
        body: {
          jsonrpc: "2.0",
          id: "beta_req_3",
          method: "tools/call",
          params: {
            name: "check_jp_travel_compliance",
            arguments: { checkType: "shinkansen_baggage", baggageTotalCm: 150 }
          }
        }
      });
      assert.strictEqual(res3.statusCode, 429, "Free beta check must be throttled on rate limit exceeded");
      assert.ok(res3.headers['retry-after']);
      assert.strictEqual(res3.body.error.code, -32029);
    } finally {
      if (prevEnv !== undefined) {
        process.env.JP_RULES_FREE_BETA = prevEnv;
      } else {
        delete process.env.JP_RULES_FREE_BETA;
      }
    }
  });

  // クリーンアップ
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (e) {}

  console.log("\n=================================================================");
  console.log(`  Japan Inbound Rules MCP テスト完了: ${passedTests} / ${totalTests} 件 PASS`);
  console.log("=================================================================");

  if (passedTests !== totalTests) {
    process.exit(1);
  }
})();
