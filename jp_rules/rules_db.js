/**
 * rules_db.js
 * Japan Inbound & Cross-Border Rules データベース管理クラス
 * ゼロ外部依存・高速オンメモリキャッシュ・純粋Node.js実装
 */

const fs = require('fs');
const path = require('path');

const SEED_DATA_PATH = path.resolve(__dirname, 'seed_data.json');

class RulesDatabase {
  constructor(dataPath = SEED_DATA_PATH) {
    this.dataPath = dataPath;
    this.data = null;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.dataPath)) {
        const raw = fs.readFileSync(this.dataPath, 'utf8');
        this.data = JSON.parse(raw);
      } else {
        this.data = { categories: {} };
      }
    } catch (err) {
      console.warn('[RulesDatabase] Failed to load data:', err.message);
      this.data = { categories: {} };
    }
  }

  save(data = this.data) {
    this.data = data;
    const jsonStr = JSON.stringify(this.data, null, 2);
    fs.writeFileSync(this.dataPath, jsonStr, 'utf8');
  }

  /**
   * カテゴリ一覧・件数・最終検証日時を返却
   * @returns {Array<Object>}
   */
  listCategories() {
    this.load();
    const categories = this.data.categories || {};
    return Object.keys(categories).map(catKey => {
      const cat = categories[catKey];
      const rules = cat.rules || [];
      return {
        id: cat.id || catKey,
        name: cat.name,
        description: cat.description,
        rule_count: rules.length,
        last_verified_at: cat.last_verified_at || this.data.last_verified_at || "2026-11-01T00:00:00Z"
      };
    });
  }

  /**
   * ルールを検索して軽量英語JSONで返却
   * @param {Object} options
   * @param {string} [options.category]
   * @param {string} [options.keyword]
   * @param {number} [options.limit=10]
   * @returns {Object} { total, count, rules }
   */
  queryRules({ category, keyword, limit = 10 } = {}) {
    this.load();
    const categories = this.data.categories || {};
    let targetRules = [];

    const catKeys = category && categories[category] ? [category] : Object.keys(categories);

    for (const key of catKeys) {
      const cat = categories[key];
      const catRules = cat.rules || [];
      for (const r of catRules) {
        targetRules.push({
          category: key,
          category_name: cat.name,
          ...r
        });
      }
    }

    if (keyword && typeof keyword === 'string') {
      const kw = keyword.toLowerCase().trim();
      if (kw) {
        targetRules = targetRules.filter(r => {
          const str = JSON.stringify(r).toLowerCase();
          return str.includes(kw);
        });
      }
    }

    const total = targetRules.length;
    const limitNum = Math.max(1, Number(limit) || 10);
    const count = Math.min(limitNum, total);
    const rules = targetRules.slice(0, count);

    return {
      total,
      count,
      rules
    };
  }

  /**
   * 旅行コンプライアンス即決判定
   * @param {Object} params
   * @param {string} params.checkType 'tax_free' | 'shinkansen_baggage' | 'holiday_peak'
   * @returns {Object}
   */
  checkCompliance(params = {}) {
    this.load();
    const { checkType } = params;

    if (!checkType) {
      const err = new Error("checkType is required. Valid options: 'tax_free', 'shinkansen_baggage', 'holiday_peak'");
      err.code = "MISSING_CHECK_TYPE";
      throw err;
    }

    // 1. 新免税制度判定 (2026年11月1日施行)
    if (checkType === 'tax_free') {
      const purchaseAmountJpy = Number(params.purchaseAmountJpy) || 0;
      const minExTax = 5000;
      const eligible = purchaseAmountJpy >= minExTax;
      const highValueInspectionLikely = purchaseAmountJpy >= 1000000;

      return {
        check_type: "tax_free",
        eligible,
        purchase_amount_jpy: purchaseAmountJpy,
        min_jpy_ex_tax: minExTax,
        refund_method: "post_departure_customs_confirmation",
        consumables_cap_abolished: true,
        sealed_bag_required: false,
        departure_deadline_days: 90,
        high_value_inspection_likely: highValueInspectionLikely,
        high_value_inspection_jpy: 1000000,
        effective_date: "2026-11-01",
        notice: eligible
          ? (highValueInspectionLikely
              ? "Eligible for tax refund. High-value purchase (>= 1,000,000 JPY) requires mandatory item inspection by customs at departure airport."
              : "Eligible for tax refund under Nov 2026 rules. Pay tax upfront at store, claim refund at airport departure customs. Sealed bags no longer required.")
          : `Not eligible for tax refund. Minimum purchase amount is ${minExTax} JPY (excluding tax). Current: ${purchaseAmountJpy} JPY.`
      };
    }

    // 2. 新幹線特大荷物ルール判定
    if (checkType === 'shinkansen_baggage') {
      const baggageTotalCm = Number(params.baggageTotalCm) || 0;
      const allowed = baggageTotalCm <= 250;
      const requiresReservation = baggageTotalCm > 160 && baggageTotalCm <= 250;
      const unreservedPenaltyJpy = requiresReservation ? 1000 : 0;

      let sizeCategory = "standard";
      let notice = "";

      if (baggageTotalCm <= 160) {
        sizeCategory = "standard (<= 160 cm)";
        notice = "No reservation required. Luggage can be placed on overhead racks or at your seat.";
      } else if (baggageTotalCm <= 250) {
        sizeCategory = "oversized (161-250 cm)";
        notice = "Advance reservation required for seat with oversized baggage area. Bringing onboard without reservation incurs a 1,000 JPY penalty fee.";
      } else {
        sizeCategory = "prohibited (> 250 cm)";
        notice = "Prohibited onboard. Baggage with total dimensions exceeding 250 cm cannot be brought onto the Shinkansen.";
      }

      return {
        check_type: "shinkansen_baggage",
        baggage_total_cm: baggageTotalCm,
        allowed,
        requires_reservation: requiresReservation,
        unreserved_penalty_jpy: unreservedPenaltyJpy,
        size_category: sizeCategory,
        max_allowed_cm: 250,
        max_weight_kg: 30,
        notice
      };
    }

    // 3. 祝日・大型連休混雑判定
    if (checkType === 'holiday_peak') {
      const travelDateStr = String(params.travelDate || '').trim();
      if (!travelDateStr) {
        const err = new Error("travelDate (YYYY-MM-DD) is required for holiday_peak check.");
        err.code = "MISSING_TRAVEL_DATE";
        throw err;
      }

      let mmDd = '';
      if (travelDateStr.includes('-')) {
        const parts = travelDateStr.split('-');
        if (parts.length === 3) {
          mmDd = `${parts[1]}-${parts[2]}`;
        } else if (parts.length === 2) {
          mmDd = `${parts[0]}-${parts[1]}`;
        }
      }

      let isPeak = false;
      let periodName = "Regular Period";
      let riskLevel = "low";
      let notice = "Standard travel period. Normal ticket availability and reservation policies apply.";

      if (mmDd >= '04-29' && mmDd <= '05-05') {
        isPeak = true;
        periodName = "Golden Week";
        riskLevel = "high";
        notice = "Peak holiday season: Golden Week. Extreme congestion on Shinkansen, expressways, and hotels. Nozomi trains frequently operate with all-reserved seating.";
      } else if (mmDd >= '08-13' && mmDd <= '08-16') {
        isPeak = true;
        periodName = "Obon Festival Season";
        riskLevel = "high";
        notice = "Peak holiday season: Obon. High demand for domestic transit and accommodations. Advance Shinkansen booking strongly recommended.";
      } else if (mmDd >= '12-29' || (mmDd >= '01-01' && mmDd <= '01-03')) {
        isPeak = true;
        periodName = "Year-End / New Year";
        riskLevel = "high";
        notice = "Peak holiday season: Year-End and New Year. Major business shutdown and heavy travel rush. Nozomi trains are typically all-reserved.";
      } else {
        // 単独祝日チェック
        const holidaysCat = this.data.categories?.holidays;
        const natHolidays = holidaysCat?.national_holidays || [];
        const matchHoliday = natHolidays.find(h => h.date === mmDd);
        if (matchHoliday) {
          isPeak = true;
          periodName = matchHoliday.name;
          riskLevel = "medium";
          notice = `National Holiday (${matchHoliday.name}). Expect increased domestic leisure travel and crowded public transport.`;
        }
      }

      return {
        check_type: "holiday_peak",
        travel_date: travelDateStr,
        is_peak: isPeak,
        period_name: periodName,
        risk_level: riskLevel,
        notice
      };
    }

    const err = new Error(`Unsupported checkType: ${checkType}. Supported types: 'tax_free', 'shinkansen_baggage', 'holiday_peak'`);
    err.code = "INVALID_CHECK_TYPE";
    throw err;
  }
}

const defaultRulesDb = new RulesDatabase();

module.exports = {
  RulesDatabase,
  defaultRulesDb
};
