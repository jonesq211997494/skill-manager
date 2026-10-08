import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = path.join(root, 'release', 'win-unpacked', 'Skill Manager.exe');
const results = path.join(root, 'test-results');
await fs.mkdir(path.join(root, '.runtime'), { recursive: true });
await fs.mkdir(results, { recursive: true });
const runtime = await fs.mkdtemp(path.join(root, '.runtime', 'desktop-lifecycle-'));
const report = {
  status: 'running', checkedAt: new Date().toISOString(), executablePath,
  limitations: ['150% 验证使用 Chromium --force-device-scale-factor=1.5；未改变 Windows 显示设置，不能替代多显示器 DPI 切换验收。'],
  checks: [],
};

async function poll(check, description, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`等待超时：${description}`);
}

async function environment(name) {
  const directory = path.join(runtime, name);
  const home = path.join(directory, 'home');
  const fixture = path.join(home, '.agents', 'skills', 'lifecycle-check');
  await fs.mkdir(fixture, { recursive: true });
  await fs.writeFile(path.join(fixture, 'SKILL.md'), '---\nname: lifecycle-check\ndescription: 窗口恢复及高分屏布局检查\n---\n# 桌面生命周期检查\n\n仅使用本次测试创建的合成技能。\n');
  const env = { ...process.env, SKILL_MANAGER_DATA_DIR: path.join(directory, 'data'), SKILL_MANAGER_HOME: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
  // 走真实首次显示路径；每次使用独立 userData，避免碰到用户原有进程锁。
  for (const key of ['ELECTRON_RUN_AS_NODE', 'SKILL_MANAGER_DEV_URL', 'SKILL_MANAGER_TEST']) delete env[key];
  return env;
}

const state = instance => instance.evaluate(({ BrowserWindow }) => {
  const windows = BrowserWindow.getAllWindows();
  return { pid: process.pid, windows: windows.map(window => ({ id: window.id, visible: window.isVisible(), minimized: window.isMinimized(), focused: window.isFocused(), bounds: window.getBounds() })) };
});

async function initialized(instance) {
  const page = await instance.firstWindow();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: '我的技能', exact: true }).waitFor();
  const first = await poll(async () => {
    const current = await state(instance);
    return current.windows.length === 1 && current.windows[0].visible && !current.windows[0].minimized ? current : false;
  }, '首次窗口正常显示');
  const scan = await page.evaluate(() => window.manager.call('scan'));
  assert.equal(scan.skills.length, 1, '必须只扫描隔离的合成技能');
  await page.reload();
  await page.getByText('lifecycle-check', { exact: true }).first().waitFor();
  return { page, first, errors };
}

async function lifecycle() {
  const env = await environment('lifecycle');
  const instance = await electron.launch({ executablePath, env, args: [], timeout: 60000 });
  let second;
  try {
    const { page, first, errors } = await initialized(instance);
    const versions = await instance.evaluate(({ app, screen }) => ({ version: app.getVersion(), packaged: app.isPackaged, electron: process.versions.electron, displays: screen.getAllDisplays().map(({ bounds, scaleFactor }) => ({ bounds, scaleFactor })) }));
    assert.equal(versions.packaged, true);
    await instance.evaluate(({ app, BrowserWindow }) => {
      globalThis.__lifecycleEvents = { secondInstance: 0, createdWindows: 0 };
      app.on('second-instance', () => { globalThis.__lifecycleEvents.secondInstance += 1; });
      app.on('browser-window-created', () => { globalThis.__lifecycleEvents.createdWindows += 1; });
      BrowserWindow.getAllWindows()[0].minimize();
    });
    const minimized = await poll(async () => {
      const current = await state(instance);
      return current.windows[0]?.minimized ? current : false;
    }, '原窗口最小化');

    // 真实再启动同一成品 EXE，验证操作系统进程锁和 second-instance 事件。
    second = spawn(executablePath, [], { env, windowsHide: true, stdio: 'ignore' });
    const secondExit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('第二进程未及时退出')), 15000);
      second.once('error', error => { clearTimeout(timer); reject(error); });
      second.once('exit', (code, signal) => { clearTimeout(timer); resolve({ pid: second.pid, code, signal }); });
    });
    assert.equal(secondExit.code, 0, '第二进程应正常退出');
    const restored = await poll(async () => {
      const current = await state(instance);
      return current.windows.length === 1 && current.windows[0].visible && !current.windows[0].minimized ? current : false;
    }, '第二次启动恢复原窗口');
    const events = await instance.evaluate(() => globalThis.__lifecycleEvents);
    assert.equal(events.secondInstance, 1);
    assert.equal(events.createdWindows, 0, '不应创建第二窗口');
    assert.equal(restored.pid, first.pid);
    assert.equal(restored.windows[0].id, first.windows[0].id);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(results, 'desktop-restored.png') });
    report.checks.push({ name: '正常首次显示、最小化后真实重复启动', status: 'passed', ...versions, first, minimized, secondExit, restored, events, rendererErrors: errors });
  } finally {
    // 只清理脚本自身创建的进程，不按应用名结束用户进程。
    if (second && second.exitCode === null) second.kill();
    await instance.close();
  }
}

async function scaledLayout() {
  const env = await environment('scale-150');
  const instance = await electron.launch({ executablePath, env, args: ['--force-device-scale-factor=1.5'], timeout: 60000 });
  try {
    const { page, first, errors } = await initialized(instance);
    const display = await instance.evaluate(({ app, screen }) => ({ argument: app.commandLine.getSwitchValue('force-device-scale-factor'), displays: screen.getAllDisplays().map(({ bounds, workArea, scaleFactor }) => ({ bounds, workArea, scaleFactor })) }));
    assert.equal(display.argument, '1.5');
    const layouts = [];
    for (const [width, height] of [[1100, 760], [960, 720]]) {
      await instance.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(size.width, size.height); window.center(); }, { width, height });
      await poll(() => page.evaluate(() => innerWidth > 0 && document.readyState === 'complete'), '布局完成');
      await page.getByRole('button', { name: /^我的技能/ }).click();
      const layout = await page.evaluate(() => {
        const bounds = element => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; };
        return { devicePixelRatio, viewport: { width: innerWidth, height: innerHeight }, document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }, navigation: [...document.querySelectorAll('.nav-item')].map(element => ({ text: element.textContent.trim(), ...bounds(element) })), bodyText: document.body.innerText.includes('lifecycle-check') };
      });
      assert.equal(layout.devicePixelRatio, 1.5, '必须实际按 1.5 DPR 渲染');
      assert.ok(layout.document.width <= layout.viewport.width + 1, '页面存在水平溢出');
      assert.ok(layout.bodyText, '技能列表必须可见');
      assert.ok(layout.navigation.length >= 7);
      for (const item of layout.navigation) {
        assert.ok(item.x >= 0 && item.y >= 0 && item.x + item.width <= layout.viewport.width + 1 && item.y + item.height <= layout.viewport.height + 1, `导航超出窗口：${item.text}`);
      }
      await page.getByText('lifecycle-check', { exact: true }).first().click();
      await page.locator('.detail-panel.is-open').waitFor();
      await page.getByRole('button', { name: '关闭详情' }).click({ trial: true });
      const detail = await page.locator('.detail-panel.is-open').boundingBox();
      assert.ok(detail && detail.x >= -1 && detail.x + detail.width <= layout.viewport.width + 1, '详情面板超出窗口');
      const screenshot = `desktop-dpi150-${width}x${height}.png`;
      await page.screenshot({ path: path.join(results, screenshot) });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: /^设置/ }).click();
      await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
      layouts.push({ windowSize: { width, height }, ...layout, detail, screenshot, settingsReachable: true });
    }
    assert.deepEqual(errors, []);
    report.checks.push({ name: '150% Chromium 渲染及真实桌面窗口布局', status: 'passed', first, display, layouts, rendererErrors: errors });
  } finally { await instance.close(); }
}

try {
  await lifecycle();
  await scaledLayout();
  report.status = 'passed';
  console.log('桌面首次显示、真实重复启动恢复及 150% 渲染布局通过。');
} catch (error) {
  report.status = 'failed';
  report.error = error.stack;
  process.exitCode = 1;
  console.error(error);
} finally {
  await fs.writeFile(path.join(results, 'desktop-lifecycle.json'), JSON.stringify(report, null, 2));
}
