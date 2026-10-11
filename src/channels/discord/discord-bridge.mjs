import { TextHarnessBridge, createTextBridgeStatus } from '../shared/text-harness-bridge.mjs';
import { harnessQuestionText } from '../shared/harness-question.mjs';

const MAX_QUESTION_BUTTONS = 5;

/**
 * Native question card: one button per option.
 *
 * Multi-select needs an accumulating control plus a submit action that Discord
 * buttons alone cannot express with this bridge, so it returns null and the
 * shared text flow keeps answering the question (an explicit fallback, not a
 * silent one: the prompt still lists the options).
 */
export const DISCORD_INTERACTION_CARD = Object.freeze({
  render(question, { questionIndex = 0, total = 1, requiresMention = false, nonce } = {}) {
    if (typeof nonce !== 'string' || !nonce) return null;
    const options = Array.isArray(question?.options) ? question.options : [];
    if (options.length === 0 || options.length > MAX_QUESTION_BUTTONS) return null;
    if (question.multiSelect === true) return null;
    if (options.some((option) => typeof option?.label !== 'string' || !option.label.trim())) {
      return null;
    }
    return {
      text: harnessQuestionText(question, questionIndex, total, {
        requiresMention,
        hasButtons: true,
      }),
      markup: {
        rows: options.map((option, optionIndex) => [{
          id: `wbq:${nonce}:${questionIndex}:${optionIndex}`,
          label: option.label.trim(),
          style: 1,
        }]),
      },
    };
  },
  parse(data) {
    if (typeof data !== 'string') return null;
    const parts = data.split(':');
    if (parts.length !== 4 || parts[0] !== 'wbq') return null;
    const [, nonce, questionIndex, optionIndex] = parts;
    const question = Number(questionIndex);
    const option = Number(optionIndex);
    if (!nonce || !Number.isSafeInteger(question) || question < 0
      || !Number.isSafeInteger(option) || option < 0) return null;
    return { nonce, questionIndex: question, optionIndex: option };
  },
});

/**
 * Native approval card: approve once / reject buttons.
 *
 * The button carries only an opaque token minted per presentation; the pending
 * request, its actor and its lifecycle stay in the shared approval queue, so a
 * stale, forwarded or already-answered press is answered with the real state.
 */
export const DISCORD_APPROVAL_CARD = Object.freeze({
  render(pending, { token, nonce } = {}) {
    if (typeof token !== 'string' || !token || typeof nonce !== 'string' || !nonce) return null;
    const request = typeof pending?.text === 'string' && pending.text.trim()
      ? pending.text.trim()
      : 'DeepSeek Harness 请求一次操作审批。';
    return {
      text: request.slice(0, 1_900),
      markup: {
        rows: [[
          { id: `wba:${token}:${nonce}:approved`, label: '批准一次', style: 3 },
          { id: `wba:${token}:${nonce}:rejected`, label: '拒绝', style: 4 },
        ]],
      },
    };
  },
  parse(data) {
    if (typeof data !== 'string') return null;
    const parts = data.split(':');
    if (parts.length !== 4 || parts[0] !== 'wba') return null;
    const [, token, nonce, outcome] = parts;
    if (!token || !nonce || !['approved', 'rejected'].includes(outcome)) return null;
    return { token, nonce, outcome };
  },
});

export const DISCORD_DESCRIPTOR = Object.freeze({
  key: 'discord',
  label: 'Discord',
  connectionLabel: ' Gateway 长连接',
  reactions: Object.freeze({ processing: '👀', success: '✅', error: '❌' }),
});

export class DiscordHarnessBridge extends TextHarnessBridge {
  constructor(options) {
    super({
      descriptor: DISCORD_DESCRIPTOR,
      approvalCard: DISCORD_APPROVAL_CARD,
      interactionCard: DISCORD_INTERACTION_CARD,
      ...options,
    });
  }
}

export { createTextBridgeStatus as createDiscordBridgeStatus };
