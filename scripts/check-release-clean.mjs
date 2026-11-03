/**
 * 发布洁净度检查（**机制**，不靠自觉）：扫描随包发布的文件，禁止机器特定内容。
 *
 * 为什么要有它：路径、用户名、本机专有目录名一旦写死，插件换机/发布就会坏掉或泄露隐私；
 * 靠"记得别写"迟早会漏，所以把规则做成可执行检查。
 *
 * 用法：`node scripts/check-release-clean.mjs`（退出码 0 = 干净；1 = 有违规并逐条列出）
 * 扫描：包内文本文件（含本检查脚本），排除依赖、版本库和本地运行数据。
 * 允许：占位符与派生写法 —— `<cwd>`、`<profile>`、`<临时目录>`、`%USERPROFILE%`、`~/.dsh`、
 *       `os.tmpdir()`、`path.join(...)`、`import.meta.url` 派生。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');

import { RELEASE_RULES as RULES } from './release-paths.mjs';

const EXT = /\.(js|mjs|cjs|json|jsonl|log|md|yml|yaml|txt|ps1)$/i;
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.codex-runner') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (EXT.test(entry.name)) files.push(full);
  }
})(ROOT);

// Only shipped files belong to the release scan. Local implementation records,
// historical tasks and acceptance evidence deliberately contain machine paths.
const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'package.json'),'utf8'));
const packaged=file=>{
  const relative=path.relative(ROOT,file).replaceAll(path.sep,'/');
  return relative==='package.json'||manifest.files.some(entry=>relative===entry
    || ['lib','drivers'].includes(entry)&&relative.startsWith(entry+'/')
    || entry==='locale/*.json'&&/^locale\/[a-z0-9-]+\.json$/i.test(relative));
};

const hits = [];
for (const file of files.filter(packaged)) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        hits.push({
          file: path.relative(ROOT, file),
          line: index + 1,
          rule: rule.id,
          why: rule.why,
          text: line.trim().slice(0, 140),
        });
      }
    }
  });
}

if (hits.length === 0) {
  console.log('release-clean: OK（扫描 ' + files.filter(packaged).length + ' 个发行文件，未发现机器特定内容）');
  process.exit(0);
}
console.log('release-clean: FAIL（' + hits.length + ' 处违规）');
for (const hit of hits) {
  console.log('  ' + hit.file + ':' + hit.line + '  [' + hit.rule + '] ' + hit.why);
  console.log('      ' + hit.text);
}
process.exit(1);
