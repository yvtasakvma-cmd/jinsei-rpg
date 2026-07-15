import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('./manifest.webmanifest', import.meta.url), 'utf8'));
const serviceWorker = fs.readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!scripts.length) throw new Error('index.html に実行スクリプトがありません。');

const elements = new Map();
const makeClassList = () => ({add(){}, remove(){}, toggle(){}, contains(){ return false; }});
const element = id => {
  if (!elements.has(id)) elements.set(id, {
    id, innerHTML:'', textContent:'', value:'', hidden:false, disabled:false,
    style:{}, classList:makeClassList(), dataset:{},
    addEventListener(){}, querySelector(){ return null; }, querySelectorAll(){ return []; }, focus(){}
  });
  return elements.get(id);
};

const storage = new Map();
const localStorage = {
  getItem:key => storage.has(key) ? storage.get(key) : null,
  setItem:(key,value) => storage.set(key,String(value)),
  removeItem:key => storage.delete(key),
  clear:() => storage.clear()
};
const document = {
  hidden:false, body:{style:{}}, documentElement:{dataset:{}}, title:'',
  getElementById:element,
  querySelector(){ return null; }, querySelectorAll(){ return []; },
  addEventListener(){}
};
const windowMock = {
  document, localStorage, crypto, Intl, console,
  addEventListener(){}, scrollTo(){}, confirm(){ return true; },
  setTimeout, clearTimeout, setInterval(){ return 1; }, clearInterval(){},
  structuredClone, FormData, Date, Math, JSON, Number, String, Boolean, Array, Object, Map, Set,
};
windowMock.window = windowMock;
windowMock.globalThis = windowMock;

vm.createContext(windowMock);
vm.runInContext(scripts.at(-1)[1], windowMock, {filename:'index.html'});

const api = windowMock.__JINSEI_RPG__;
const results = [];
const test = (name, fn) => {
  try { fn(); results.push({name, ok:true}); }
  catch (error) { results.push({name, ok:false, error:error.message}); }
};
const equal = (actual, expected, message='') => {
  if (Math.abs(Number(actual) - Number(expected)) > 1e-9) throw new Error(`${message} expected=${expected}, actual=${actual}`);
};
const truthy = (value, message='条件を満たしていません') => { if (!value) throw new Error(message); };

test('初期修業テーマと換算率', () => {
  const state = api.getState();
  equal(state.trainingThemes.find(t=>t.name==='ドラム').secondsPerPoint, 450, 'ドラム');
  equal(state.trainingThemes.find(t=>t.name==='金融').secondsPerPoint, 600, '金融');
  equal(state.trainingThemes.find(t=>t.name==='エアロバイク').secondsPerPoint, 300, 'エアロバイク');
});

test('修業ごとのポイント計算', () => {
  equal(api.calculateTrainingPoints(1800,{earnsPoints:true,secondsPerPoint:450,multiplier:1,fixedBonus:0}),4,'ドラム30分');
  equal(api.calculateTrainingPoints(1800,{earnsPoints:true,secondsPerPoint:600,multiplier:1,fixedBonus:0}),3,'金融30分');
  equal(api.calculateTrainingPoints(1800,{earnsPoints:true,secondsPerPoint:300,multiplier:1,fixedBonus:0}),6,'エアロバイク30分');
});

test('倍率と固定ボーナス', () => {
  equal(api.calculateTrainingPoints(1800,{earnsPoints:true,secondsPerPoint:600,multiplier:1.5,fixedBonus:1}),5.5);
});

test('履歴からポイント残高を再計算', () => {
  const state = api.getState();
  state.trainingHistory=[{earnedPoints:10.5}];
  state.rewardHistory=[{usedPoints:3.25}];
  state.pointAdjustments=[{amount:-1},{amount:2}];
  api.setState(state);
  const summary=api.pointSummary();
  equal(summary.balance,8.25);
});

test('設定変更後も過去履歴は再計算しない', () => {
  const state=api.getState();
  state.trainingHistory=[{earnedPoints:4,secondsPerPoint:450}];
  state.trainingThemes.find(t=>t.name==='ドラム').secondsPerPoint=900;
  api.setState(state);
  equal(api.pointSummary().earned,4);
});

test('一時停止と再読み込み相当のタイマー復元', () => {
  const running={status:'running',accumulatedMs:3000,lastStartedAt:'2026-07-15T00:00:00.000Z'};
  equal(api.activeTrainingElapsedMs(running,new Date('2026-07-15T00:00:07.000Z').getTime()),10000);
  equal(api.activeTrainingElapsedMs({...running,status:'paused'},new Date('2026-07-15T00:30:00.000Z').getTime()),3000);
});

test('同じセッションIDの二重登録を防止', () => {
  api.reset();
  truthy(api.commitTrainingHistoryEntry({id:'a',sourceSessionId:'session-1',earnedPoints:1}));
  truthy(!api.commitTrainingHistoryEntry({id:'b',sourceSessionId:'session-1',earnedPoints:1}));
  equal(api.getState().trainingHistory.length,1);
});

test('初期報酬と時間型ポイント消費', () => {
  api.reset();
  const game=api.getState().rewards.find(r=>r.name==='ゲーム');
  equal(game.pointCostPerMinute,1);
  equal(api.calculateRewardPointCost(90,{pointCostPerMinute:1}),1.5);
});

test('報酬タイマーはポイント残高を超えない', () => {
  const state=api.getState();
  state.trainingHistory=[{earnedPoints:5}];state.rewardHistory=[];state.pointAdjustments=[];
  const timer={status:'running',accumulatedMs:0,lastStartedAt:'2026-07-15T00:00:00.000Z',snapshot:{pointCostPerMinute:1}};
  state.activeRewardTimer=timer;api.setState(state);
  equal(api.rewardAffordableMs(timer),300000);
  equal(api.activeRewardElapsedMs(timer,new Date('2026-07-15T00:10:00.000Z').getTime()),300000);
});

test('報酬履歴の二重消費防止と残高再計算', () => {
  api.reset();
  let state=api.getState();state.trainingHistory=[{earnedPoints:10}];api.setState(state);
  truthy(api.commitRewardHistoryEntry({id:'r1',sourceSessionId:'reward-session-1',usedPoints:3}));
  truthy(!api.commitRewardHistoryEntry({id:'r2',sourceSessionId:'reward-session-1',usedPoints:3}));
  equal(api.pointSummary().balance,7);
});

test('初期カロリー報酬は500kcal', () => {
  api.reset();
  const beer=api.getState().rewards.find(r=>r.name==='ビール500ml');
  equal(beer.requiredCalories,500);
  equal(beer.calorieCost,500);
});

test('620kcalから交換すると120kcalを繰り越す', () => {
  let state=api.getState();state.calorieHistory=[{amount:620}];state.trainingHistory=[];state.rewardHistory=[];api.setState(state);
  equal(api.calorieSummary().balance,620);
  truthy(api.commitRewardHistoryEntry({id:'c-use-1',sourceSessionId:'calorie-use-1',usedPoints:0,usedCalories:500}));
  equal(api.calorieSummary().balance,120);
});

test('1200kcalなら2回交換後も200kcalを保持', () => {
  api.reset();let state=api.getState();state.calorieHistory=[{amount:1200}];api.setState(state);
  api.commitRewardHistoryEntry({id:'c1',sourceSessionId:'cu1',usedCalories:500,usedPoints:0});
  api.commitRewardHistoryEntry({id:'c2',sourceSessionId:'cu2',usedCalories:500,usedPoints:0});
  equal(api.calorieSummary().balance,200);
});

test('修業入力カロリーと手動入力を合算', () => {
  api.reset();let state=api.getState();state.trainingHistory=[{earnedPoints:0,activeCalories:200}];state.calorieHistory=[{amount:150}];api.setState(state);
  equal(api.calorieSummary().balance,350);
});

test('週間集計は月曜日から日曜日', () => {
  const range=api.rangeForPeriod('week',new Date('2026-07-15T12:00:00+09:00'));
  const start=new Date(range[0]);const end=new Date(range[1]);
  equal(start.getDay(),1);equal((end-start)/86400000,7);
});

test('今日・今週・今月・通算の合計計算', () => {
  const entries=[{durationSeconds:600,earnedPoints:1,activeCalories:0},{durationSeconds:1200,earnedPoints:2,activeCalories:20}];
  const totals=api.trainingTotals(entries);equal(totals.seconds,1800);equal(totals.points,3);equal(totals.count,2);
});

test('待機タイマーは終了予定日時から復元', () => {
  const timer={endsAt:'2026-07-15T03:00:00.000Z'};
  equal(api.waitTimerRemainingMs(timer,new Date('2026-07-15T01:30:00.000Z').getTime()),5400000);
  equal(api.waitTimerRemainingMs(timer,new Date('2026-07-15T04:00:00.000Z').getTime()),0);
});

test('連続修業日数と実績判定', () => {
  api.reset();let state=api.getState();
  state.trainingHistory=['2026-07-10','2026-07-11','2026-07-12','2026-07-13'].map((date,index)=>({id:`s${index}`,themeId:'theme-default-1',themeName:'ドラム',endAt:`${date}T12:00:00+09:00`,durationSeconds:60,earnedPoints:1,activeCalories:0}));
  api.setState(state);
  equal(api.streakSummary().longest,4);
  truthy(api.achievementConditions()['streak-4']);
});

test('報酬使用後も通算獲得ポイントのレベルは下がらない', () => {
  api.reset();let state=api.getState();state.trainingHistory=[{earnedPoints:250,durationSeconds:60,endAt:'2026-07-15T00:00:00Z'}];state.rewardHistory=[{usedPoints:240,endAt:'2026-07-15T01:00:00Z'}];api.setState(state);
  equal(api.pointSummary().balance,10);equal(api.getLevel(api.pointSummary().earned).current.level,3);
});

test('履歴編集相当の変更後に残高を再計算', () => {
  api.reset();let state=api.getState();state.trainingHistory=[{id:'t1',earnedPoints:10,durationSeconds:600,endAt:'2026-07-15T00:00:00Z'}];state.rewardHistory=[{id:'r1',usedPoints:4,endAt:'2026-07-15T01:00:00Z'}];api.setState(state);equal(api.pointSummary().balance,6);
  state=api.getState();state.trainingHistory[0].earnedPoints=7;api.setState(state);equal(api.pointSummary().balance,3);
});

test('履歴変更後に報酬使用後残高のスナップショットも更新', () => {
  api.reset();let state=api.getState();state.trainingHistory=[{id:'t1',earnedPoints:10,durationSeconds:60,endAt:'2026-07-15T00:00:00Z'}];state.rewardHistory=[{id:'r1',usedPoints:4,usedCalories:0,endAt:'2026-07-15T01:00:00Z'}];api.setState(state);equal(api.getState().rewardHistory[0].balanceAfter,6);
});

test('JSONエクスポートはバージョンと全データを含む', () => {
  const exported=JSON.parse(api.exportedJson());equal(exported.schemaVersion,8);truthy(Array.isArray(exported.trainingThemes));truthy(Array.isArray(exported.rewardHistory));truthy(Array.isArray(exported.cashUsageHistory));truthy(exported.settings);
});

test('JSON追加インポートは重複IDを除外', () => {
  api.reset();const imported=api.getState();imported.trainingHistory=[{id:'dup',earnedPoints:1},{id:'new',earnedPoints:2}];let current=api.getState();current.trainingHistory=[{id:'dup',earnedPoints:9}];api.setState(current);
  const merged=api.mergeState(imported);truthy(merged.duplicates.some(item=>item.includes('dup')));equal(merged.next.trainingHistory.length,2);equal(merged.next.trainingHistory.find(item=>item.id==='dup').earnedPoints,9);
});

test('localStorageへ状態全体を保存', () => {
  const saved=JSON.parse(storage.get(api.storageKey));
  for(const key of ['settings','trainingThemes','rewards','trainingHistory','rewardHistory','cashUsageHistory','calorieHistory','waitHistory','pointAdjustments','achievements'])truthy(key in saved,`${key} が保存されていません`);
  truthy('activeTrainingTimer' in saved&&'activeRewardTimer' in saved&&'activeWaitTimer' in saved,'タイマー状態が保存されていません');
});

test('スマートフォン向け6画面ナビゲーション', () => {
  equal((html.match(/class="nav-btn/g)||[]).length,6);truthy(html.includes('viewport-fit=cover'));truthy(html.includes('env(safe-area-inset-bottom)'));
});

test('主要操作と履歴編集の入口が存在', () => {
  for(const action of ['start-training','open-training-manual','start-reward','open-calorie-input','start-wait','edit-history','export-data','import-data'])truthy(html.includes(`data-action="${action}"`),`${action} がありません`);
});

test('アプリ本体は外部ライブラリを読み込まない', () => {
  truthy(!/<script[^>]+src=/i.test(html));truthy(!/<link[^>]+rel=["']stylesheet/i.test(html));
});

test('不正なインポート形式を拒否', () => {
  let rejected=false;try{api.validateImport([]);}catch{rejected=true;}truthy(rejected);
});

test('分未満の秒を切り捨てず表示', () => {
  api.reset();
  if (api.formatLongDuration(450) !== '7分30秒') throw new Error(`450秒の表示: ${api.formatLongDuration(450)}`);
  if (api.formatLongDuration(420) !== '7分') throw new Error(`420秒の表示: ${api.formatLongDuration(420)}`);
  if (api.formatLongDuration(3630) !== '1時間30秒') throw new Error(`3630秒の表示: ${api.formatLongDuration(3630)}`);
});

test('ビール報酬に現金化の選択肢と設定金額がある', () => {
  api.reset();
  const beer=api.getState().rewards.find(reward=>reward.name==='ビール500ml');
  truthy(beer.cashAlternativeEnabled);
  equal(beer.cashAlternativeAmount,300);
});

test('現金化でもカロリーを消費し金額を累計', () => {
  api.reset();let state=api.getState();state.calorieHistory=[{amount:620}];state.rewardHistory=[{id:'cash1',rewardId:'reward-default-7',rewardOutcome:'cash',cashAmount:300,usedCalories:500,usedPoints:0,endAt:'2026-07-15T01:00:00Z'}];api.setState(state);
  equal(api.calorieSummary().balance,120);
  equal(api.cashRewardSummary().total,300);
  equal(api.cashRewardSummary().balance,300);
  equal(api.cashRewardSummary().count,1);
});

test('現金報酬を使用すると指定額だけ残高が減る', () => {
  api.reset();let state=api.getState();state.rewardHistory=[{id:'cash-earn',rewardOutcome:'cash',cashAmount:500,usedCalories:500,endAt:'2026-07-15T01:00:00Z'}];api.setState(state);
  truthy(api.commitCashUsageEntry({id:'cash-use',sourceSessionId:'cash-session-1',amount:180,usedAt:'2026-07-15T02:00:00Z'}));
  equal(api.cashRewardSummary().earned,500);
  equal(api.cashRewardSummary().used,180);
  equal(api.cashRewardSummary().balance,320);
});

test('現金報酬は残高超過と二重使用を防ぐ', () => {
  truthy(!api.commitCashUsageEntry({id:'cash-duplicate',sourceSessionId:'cash-session-1',amount:10,usedAt:'2026-07-15T02:01:00Z'}));
  truthy(!api.commitCashUsageEntry({id:'cash-over',sourceSessionId:'cash-session-2',amount:321,usedAt:'2026-07-15T02:02:00Z'}));
  equal(api.cashRewardSummary().balance,320);
});

test('現金報酬の使用操作と履歴画面がある', () => {
  truthy(html.includes('data-action="open-cash-usage"'));
  truthy(html.includes('id="cash-usage-form"'));
  truthy(html.includes('現金報酬の使用履歴'));
});

test('報酬タイマー終了時の停止通知が初期設定で有効', () => {
  api.reset();
  const settings=api.getState().settings;
  truthy(settings.rewardTimerAlarm);
  truthy(settings.rewardAlarmSound);
  truthy(settings.rewardAlarmVibration);
  truthy(api.shouldRewardLimitAlarm({status:'limit',rewardAlarmDismissedAt:null}));
  truthy(!api.shouldRewardLimitAlarm({status:'limit',rewardAlarmDismissedAt:'2026-07-15T03:00:00Z'}));
});

test('報酬タイマー終了画面に停止と精算ボタンがある', () => {
  truthy(html.includes('id="reward-limit-alert"'));
  truthy(html.includes('data-action="stop-reward-alarm"'));
  truthy(html.includes('data-action="stop-and-finish-reward"'));
  truthy(html.includes("navigator.vibrate([500,250,500])"));
  truthy(html.includes('setInterval(rewardAlarmPulse,1800)'));
});

test('カロリー報酬に通常使用と現金化の両ボタン', () => {
  truthy(html.includes('data-action="use-calorie-reward"'));
  truthy(html.includes('data-action="cash-calorie-reward"'));
});

test('PWAマニフェストはGitHub Pagesのサブフォルダに対応', () => {
  truthy(html.includes('rel="manifest" href="./manifest.webmanifest"'));
  truthy(manifest.start_url === './' && manifest.scope === './');
  truthy(manifest.display === 'standalone');
});

test('iPhone用ホーム画面アイコンを設定', () => {
  truthy(html.includes('rel="apple-touch-icon"'));
  for (const file of ['icon-192.png','icon-512.png','icon-512-maskable.png','apple-touch-icon.png']) {
    truthy(fs.existsSync(new URL(`./icons/${file}`, import.meta.url)), `${file} がありません`);
  }
});

test('Service Workerでオフライン起動と更新を管理', () => {
  truthy(html.includes("serviceWorker.register('./sw.js', {scope:'./'})"));
  truthy(serviceWorker.includes("caches.open(CACHE_NAME)"));
  truthy(serviceWorker.includes("scopedUrl('./index.html')"));
  truthy(serviceWorker.includes('SKIP_WAITING'));
});

const failed = results.filter(result => !result.ok);
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.error ? `: ${result.error}` : ''}`);
console.log(`\n${results.length - failed.length}/${results.length} tests passed`);
if (failed.length) process.exitCode = 1;
