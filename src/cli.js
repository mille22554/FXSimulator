#!/usr/bin/env node
/**
 * FXSimulator M1 CLI。
 *
 *   node src/cli.js init
 *   node src/cli.js status
 *   node src/cli.js tick 60
 *   node src/cli.js open --side long --margin 1000 --leverage 10 [--sl 0.5] [--tp 1]
 *   node src/cli.js close 1
 *   node src/cli.js candles 10
 *   node src/cli.js events 10
 *   node src/cli.js scenario roundtrip|pump|liquidation|gap|opposing
 *   node src/cli.js reset
 *
 * 通用選項：--db <path>（或環境變數 FXSIM_DB）、--seed <n>、--user <id>
 * --sl / --tp 單位為「百分比數字」：0.5 代表 0.5%。
 */

import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEFAULT_LEVERAGE, DEFAULT_SEED, DEFAULT_USER_ID } from './config.js';
import { Engine } from './engine.js';
import { openSqliteStore } from './db.js';
import { formatE4, formatMilli, formatPct } from './money.js';
import { runScenario, SCENARIOS } from './scenarios.js';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function dbPathFrom(flags) {
  return resolve(flags.db ?? process.env.FXSIM_DB ?? 'fxsim.db');
}

async function openEngine(flags) {
  const store = await openSqliteStore(dbPathFrom(flags));
  const seed = flags.seed !== undefined ? Number(flags.seed) : DEFAULT_SEED;
  const userId = flags.user !== undefined ? Number(flags.user) : DEFAULT_USER_ID;
  const engine = new Engine({ seed, store, userId });
  engine.load();
  engine.init();
  return engine;
}

function printStatus(engine, userId) {
  const s = engine.status(userId);
  if (!s) {
    console.log('（查無此帳號）');
    return;
  }
  console.log(`tick_id      : ${s.tickId}（已執行 ${s.ticksExecuted} ticks）`);
  console.log(`價格         : ${s.price.toFixed(4)}（基準 ${s.basePrice.toFixed(4)}，衝擊 ${formatPct(s.impact, 4)}）`);
  console.log(`全服淨部位   : ${formatMilli(Math.round(s.netNotionalA * 1000))}`);
  console.log(`L（流動性）   : ${Math.round(s.L).toLocaleString('en-US')} A`);
  console.log(`現金餘額     : ${formatMilli(s.balanceMilli)}（結算於 tick ${s.settledTickId}）`);
  console.log(`可用餘額     : ${formatMilli(s.availableMilli)}`);
  console.log(`在場保證金   : ${formatMilli(s.marginMilli)}`);
  console.log(`權益         : ${formatMilli(s.equityMilli)}`);
  if (s.positions.length === 0) {
    console.log('持倉         : （無）');
  } else {
    console.log('持倉:');
    for (const p of s.positions) {
      console.log(
        `  #${p.id} ${p.side} 名目 ${formatMilli(p.notionalMilli)} @ ${formatE4(p.entryPriceE4)} ` +
          `${p.leverage}× 保證金 ${formatMilli(p.marginMilli)} 強平 ${formatE4(p.liqPriceE4)}`,
      );
    }
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  if (!cmd || cmd === 'help' || flags.help) {
    console.log(`用法：
  node src/cli.js init
  node src/cli.js status
  node src/cli.js tick <N>
  node src/cli.js open --side long|short --margin <A> --leverage <N> [--sl <pct>] [--tp <pct>]
  node src/cli.js close <positionId>
  node src/cli.js candles <N>
  node src/cli.js events <N>
  node src/cli.js scenario <${Object.keys(SCENARIOS).join('|')}>
  node src/cli.js reset

選項：--db <path>  --seed <n>  --user <id>
--sl / --tp 以百分比數字表示（0.5 = 0.5%）。`);
    return;
  }

  if (cmd === 'reset') {
    const path = dbPathFrom(flags);
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${path}${suffix}`;
      if (existsSync(f)) rmSync(f);
    }
    console.log(`已刪除 ${path}`);
    const engine = await openEngine(flags);
    engine.persist();
    engine.store.close();
    console.log('已重新初始化（起始資金 100,000 A）。');
    return;
  }

  const engine = await openEngine(flags);
  const userId = engine.userId;

  try {
    switch (cmd) {
      case 'init': {
        engine.persist();
        console.log(`已初始化資料庫 ${dbPathFrom(flags)}`);
        printStatus(engine, userId);
        break;
      }
      case 'status': {
        printStatus(engine, userId);
        break;
      }
      case 'tick': {
        const n = Number(positional[1] ?? 1);
        if (!Number.isFinite(n) || n <= 0) throw new Error('tick 需要正整數');
        engine.tick(n);
        engine.persist();
        printStatus(engine, userId);
        break;
      }
      case 'open': {
        const side = flags.side ?? 'long';
        const marginA = Number(flags.margin);
        const leverage = Number(flags.leverage ?? DEFAULT_LEVERAGE);
        const slPct = flags.sl !== undefined ? Number(flags.sl) / 100 : null;
        const tpPct = flags.tp !== undefined ? Number(flags.tp) / 100 : null;
        if (!Number.isFinite(marginA)) throw new Error('open 需要 --margin');
        const r = engine.open(userId, { side, marginA, leverage, slPct, tpPct });
        if (!r.ok) {
          console.log(`開倉被拒：${r.reason}`);
          process.exitCode = 1;
          break;
        }
        engine.persist();
        console.log(
          `已開倉 #${r.position.id} ${side} 名目 ${formatMilli(r.notionalMilli)} ` +
            `@ ${formatE4(r.entryPriceE4)}（保證金 ${formatMilli(r.marginMilli)}）`,
        );
        if (r.truncated) console.log('（名目已依上限截斷）');
        printStatus(engine, userId);
        break;
      }
      case 'close': {
        const id = positional[1];
        if (!id) throw new Error('close 需要持倉 id');
        const r = engine.close(userId, id);
        if (!r.ok) {
          console.log(`平倉被拒：${r.reason}`);
          process.exitCode = 1;
          break;
        }
        engine.persist();
        console.log(
          `已平倉 #${r.position.id} @ ${formatE4(r.exitPriceE4)}，損益 ${formatMilli(r.pnlMilli)}`,
        );
        printStatus(engine, userId);
        break;
      }
      case 'candles': {
        const n = Number(positional[1] ?? 10);
        const rows = engine.candles(n);
        console.log('minute_id  open     high     low      close    base     net_notional      volume');
        for (const c of rows) {
          console.log(
            `${String(c.minute_id).padEnd(10)} ${formatE4(c.open_e4)}  ${formatE4(c.high_e4)}  ` +
              `${formatE4(c.low_e4)}  ${formatE4(c.close_e4)}  ${formatE4(c.base_close_e4)}  ` +
              `${formatMilli(c.net_notional_milli).padEnd(14)} ${formatMilli(c.volume_notional_milli)}`,
          );
        }
        break;
      }
      case 'events': {
        const n = Number(positional[1] ?? 10);
        const rows = engine.events(n);
        console.log('id   tick    類型        跳空        標題');
        for (const e of rows) {
          console.log(
            `${String(e.id).padEnd(4)} ${String(e.ts).padEnd(7)} ${String(e.type).padEnd(11)} ` +
              `${formatPct(e.impact_jump).padEnd(11)} ${e.headline}`,
          );
        }
        break;
      }
      case 'scenario': {
        const name = positional[1];
        if (!name || !SCENARIOS[name]) {
          throw new Error(`scenario 需為：${Object.keys(SCENARIOS).join('|')}`);
        }
        const report = runScenario(engine, name);
        console.log(`[${name}]`);
        if (report.error) {
          console.log(`  執行失敗：${report.error}`);
          process.exitCode = 1;
          break;
        }
        for (const line of report.lines) console.log(line);
        engine.persist();
        break;
      }
      default:
        throw new Error(`未知指令：${cmd}`);
    }
  } finally {
    engine.store.close();
  }
}

main().catch((err) => {
  console.error(`錯誤：${err.message}`);
  process.exitCode = 1;
});
