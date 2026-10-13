import { TextHarnessBridge, createTextBridgeStatus } from '../shared/text-harness-bridge.mjs';
import { harnessQuestionText } from '../shared/harness-question.mjs';

const MAX_QUESTION_BUTTONS = 5;

/**
 * Native questions use buttons for short single choices and a string select
 * for larger or multiple choices. Text replies remain available for additions.
 */
export const DISCORD_INTERACTION_CARD = Object.freeze({
  render(question, { questionIndex = 0, total = 1, requiresMention = false, nonce } = {}) {
    if (typeof nonce !== 'string' || !nonce) return null;
    const options = Array.isArray(question?.options) ? question.options : [];
    if (options.length === 0 || options.length > 25) return null;
    if (options.some((option) => typeof option?.label !== 'string' || !option.label.trim())) {
      return null;
    }
    const useSelect = question.multiSelect === true || options.length > MAX_QUESTION_BUTTONS;
    return {
      text: harnessQuestionText(question, questionIndex, total, {
        requiresMention,
        hasButtons: true,
      }),
      markup: useSelect ? {
        components: [{ type: 1, components: [{
          type: 3,
          custom_id: `wbq:${nonce}:${questionIndex}:select`,
          min_values: 1,
          max_values: question.multiSelect === true ? options.length : 1,
          options: options.map((option, i) => ({
            label: [...option.label.trim()].slice(0, 100).join(''), value: String(i),
          })),
        }] }],
      } : {
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
    if (nonce && Number.isSafeInteger(question) && question >= 0 && optionIndex === 'select') {
      return { nonce, questionIndex: question, mode: 'select' };
    }
    const option = Number(optionIndex);
    if (!nonce || !Number.isSafeInteger(question) || question < 0
      || !Number.isSafeInteger(option) || option < 0) return null;
    return { nonce, questionIndex: question, optionIndex: option };
  },
  answer(question, parsed, callback) {
    if (parsed?.mode !== 'select') return null;
    const values = callback?.values;
    if (!Array.isArray(values) || values.length === 0 || new Set(values).size !== values.length
      || (question.multiSelect !== true && values.length !== 1)) return null;
    const options = question.options ?? [];
    if (values.some((value) => typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)
      || !options[Number(value)])) return null;
    return { id: question.id, selected: values.map((value) => options[Number(value)].label) };
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
