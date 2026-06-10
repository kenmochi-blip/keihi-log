#!/usr/bin/env node
/**
 * Gemini無料枠の実測スクリプト
 * 使い方: GEMINI_API_KEY=xxxx node tools/measure-gemini-quota.mjs [モデル名] [最大送信数]
 *
 * - 最小トークンのリクエストを6秒間隔で送信（RPM制限を回避）
 * - 429が返ったら、エラー詳細からクォータ上限値（RPD/RPM）を抽出して表示
 * - ⚠️ 1日分のRPDクォータを消費するため、本番チームのキーではなく
 *   検証用プロジェクトのキーで実行することを推奨
 */

const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('GEMINI_API_KEY を環境変数で指定してください'); process.exit(1); }

const MODEL = process.argv[2] || 'gemini-2.5-flash';
const MAX   = Number(process.argv[3] || 300);
const URL   = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const body = JSON.stringify({
  contents: [{ parts: [{ text: 'hi' }] }],
  generationConfig: { maxOutputTokens: 1 },
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

let ok = 0;
for (let i = 1; i <= MAX; i++) {
  const resp = await fetch(`${URL}?key=${KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  if (resp.ok) {
    ok++;
    process.stdout.write(`\r成功 ${ok} 件目 (${MODEL})`);
    await sleep(6500); // 10 RPM 想定で安全マージン
    continue;
  }
  const err = await resp.json().catch(() => ({}));
  console.log(`\n\nHTTP ${resp.status} が返りました（成功 ${ok} 件後）`);
  if (resp.status === 429) {
    // エラー詳細から QuotaFailure / quota_value を抽出
    const details = err.error?.details || [];
    for (const d of details) {
      if (d['@type']?.includes('QuotaFailure')) {
        for (const v of d.violations || []) {
          console.log(`  クォータ: ${v.quotaId || v.subject || ''}`);
          if (v.quotaValue) console.log(`  上限値: ${v.quotaValue}`);
          if (v.quotaMetric) console.log(`  メトリック: ${v.quotaMetric}`);
        }
      }
      if (d['@type']?.includes('RetryInfo')) {
        console.log(`  リトライ待機: ${d.retryDelay}`);
      }
    }
    console.log('\n--- 生レスポンス ---');
    console.log(JSON.stringify(err, null, 2));
    // RPM制限の可能性もあるので70秒待って1回だけ再試行し、RPDかRPMかを判別
    console.log('\n70秒待ってRPM制限かRPD制限かを判別します...');
    await sleep(70_000);
    const retry = await fetch(`${URL}?key=${KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    if (retry.ok) {
      console.log('→ 再試行成功：さっきの429は【RPM（分間）制限】でした。測定を続行するには再実行してください。');
    } else {
      console.log(`→ 再試行も ${retry.status}：【RPD（1日）上限】に到達した可能性が高いです。本日の上限 ≒ ${ok} 件`);
    }
  } else {
    console.log(JSON.stringify(err, null, 2));
  }
  process.exit(0);
}
console.log(`\n${MAX} 件すべて成功。RPDは少なくとも ${MAX} 以上です。`);
