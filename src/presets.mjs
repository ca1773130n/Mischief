// Opt-in building blocks. Nothing here is applied unless a config asks for it,
// except `danger.en`, which is the default guardrail pattern.

/**
 * Destructive / billing / session-ending verbs, per language.
 *
 * These match on the VISIBLE LABEL of a control (innerText + aria-label +
 * title). That is the whole safety story and it has a known hole: an icon-only
 * delete button with no accessible name is invisible to every pattern below.
 * Put `data-qa-ignore` on destructive controls; do not rely on the regex alone.
 */
export const danger = {
  en: /(logout|sign\s?out|delete|remove|revoke|checkout|subscribe|pay|purchase|cancel\s+subscription|reset|clear\s+all|deactivate|terminate|destroy)/i,
  ko: /(삭제|지우기|탈퇴|해지|로그아웃|구독|결제|초기화|비우기|결제하기|해지하기)/i,
  ja: /(削除|退会|解約|ログアウト|購入|決済|支払い|初期化|リセット)/i,
  zh: /(删除|注销|退订|登出|退出登录|购买|支付|结算|重置|清空)/i,
};

/**
 * Markup that leaked into rendered TEXT. Off by default: which of these counts
 * as a defect is entirely app-specific (a docs site legitimately renders `\frac`
 * as prose). Opt in per project.
 */
export const textPatterns = {
  /**
   * Unrendered LaTeX. Deliberately narrow so prices never match: a closing `$`
   * is required AND the span between must contain math-ish content (a backslash
   * command, a sub/superscript, a brace) or be a short all-numeric token. So
   * "Pro $29 / Max $99" cannot pair — " / Max " is neither.
   */
  latexMath: { name: 'latex-math', re: /\$(?:[^$\n]{0,30}[\\^_{}][^$\n]{0,30}|\d{1,4})\$/, severity: 'high' },
  latexCmd: {
    name: 'latex-cmd',
    re: /\\(?:textbf|textit|eqref|ref|cite|mathrm|rm|dagger|ddagger|times|pm|geq|leq|alpha|beta|pi|epsilon|sqrt|frac|degree|cmark|xmark)\b/,
    severity: 'high',
  },
  /** A dotted lowercase path in prose is what a locale renders when a key is missing. */
  i18nKey: { name: 'i18n-key', re: /(?:^|\s)[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+){2,}(?:\s|$)/, severity: 'high' },
};

/** Elements whose text is math source, not a leak. Pair with textPatterns.latex*. */
export const KATEX_SKIP_SELECTOR = '.katex, .katex-mathml, annotation';

/** Console noise from common frameworks. Add to `network.consoleIgnore`. */
export const consoleIgnore = {
  vue: [/Download the Vue Devtools/],
  vueI18n: [/\[intlify\]/],
  react: [/Download the React DevTools/],
  vite: [/\[vite\] connect(ed|ing)/],
};

/** Combine several patterns into one case-insensitive alternation. */
export function combinePatterns(...res) {
  const parts = res.filter(Boolean).map((r) => `(?:${r.source})`);
  return new RegExp(parts.join('|'), 'i');
}
