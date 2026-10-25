/**
 * 「额度触顶」判定的**纯函数**实现 —— 可单测，而且**每次判定都必须能说出凭哪条证据**。
 *
 * 为什么单独成模块（2026-10-11 实测事故）：这条判定直接决定一次运行被记成 `ok` 还是
 * `quota-blocked`。原实现有两条互相叠加的缺陷：
 *   1) **逐行扫描整个 stdout**（其中包含 agent 读到的源码、日志、命令回显）；
 *   2) 模式里有一条**裸 `/429/`**。
 * 于是一次**正常完成**的运行（末尾 `turn.completed`、107 行里 0 个 error 事件）因为源码片段里的
 * **行号 `2429:`** 命中 `/429/`，被误判成"额度耗尽"——并让指挥方据此向用户报告了错误的结论。
 *
 * 现在的纪律：
 *   · **只认协议级证据**：`error` / `turn.failed` 事件的文本，或 rollout 里的触顶标记/用量；
 *   · **绝不扫描 agent 输出**（命令回显、文件内容都不受控）；
 *   · 数字模式带**词边界**（`\b429\b`），不再命中 `2429:` 这类上下文。
 */

/** 额度文案模式（只用于协议级错误文本）。 */
export const QUOTA_PATTERNS = [
  /usage limit/i,
  /rate limit/i,
  /rate_limit/i,
  /insufficient_quota/i,
  /quota exceeded/i,
  /\b429\b/,                       // 词边界：不匹配 "2429:"、"14293" 这类
  /quota has been exhausted/i,
  /You've hit your usage limit/i,
  /\bresets? at\b/i,
];

/**
 * 在一段**受控文本**里找额度证据。
 * @param text - 只应传协议错误载荷（不要传 agent 输出）
 * @returns 命中的模式字符串，或 null
 */
export function quotaEvidence(text) {
  const s = String(text == null ? '' : text);
  for (const re of QUOTA_PATTERNS) if (re.test(s)) return String(re);
  return null;
}

/**
 * 取一个协议事件的"可判定错误文本"——**只认** `error` / `turn.failed`。
 * 其它事件（含 item.*、命令回显）一律返回 null，从源头上杜绝误报。
 */
export function errorTextOf(event) {
  if (!event || (event.type !== 'error' && event.type !== 'turn.failed')) return null;
  const parts = [];
  if (typeof event.message === 'string') parts.push(event.message);
  if (event.error) parts.push(typeof event.error === 'string' ? event.error : JSON.stringify(event.error));
  return parts.length ? parts.join(' | ') : JSON.stringify(event);
}

/**
 * 综合判定一次运行是否真的额度触顶。
 * @param errorTexts - 协议错误文本列表（有序，取第一条命中）
 * @param reached - rollout 里的 `rate_limit_reached_type`
 * @param afterPct - rollout 里的 5h 用量百分比
 * @returns {{blocked: boolean, evidence: string|null, source: string|null}}
 */
export function quotaVerdict({ errorTexts = [], reached = null, afterPct = null }) {
  for (const text of errorTexts) {
    const hit = quotaEvidence(text);
    if (hit) return { blocked: true, evidence: 'error matched ' + hit, source: 'error-event' };
  }
  if (reached) return { blocked: true, evidence: 'rate_limit_reached_type=' + reached, source: 'rollout' };
  if (typeof afterPct === 'number' && Number.isFinite(afterPct) && afterPct >= 100) {
    return { blocked: true, evidence: 'used_percent=' + afterPct, source: 'rollout' };
  }
  return { blocked: false, evidence: null, source: null };
}
