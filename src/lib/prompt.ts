// LLM prompts, per language: the model answers in the analysis language.
export const PROMPT_VERSION = "describe-v1";

const RESPONSE_SHAPE = `{
  "features":   [{"id": "<feature id>", "name": "<...>", "description": "<...>"}],
  "components": [{"id": "<component id>", "name": "<...>"}],
  "sinks":      [{"id": "<sink id>", "name": "<...>"}]
}`;

const DESCRIBE: Record<string, string> = {
  ru: `Ты называешь и объясняешь функции бэкенд-сервиса для читателей, которые не являются разработчиками (аналитики, менеджеры).
На вход приходит JSON: фичи (их триггеры, шаги через компоненты кода и стоки, до которых они доходят), а также задействованные компоненты и стоки.
Используй только эти данные; не придумывай поведение, которого в них не видно.

Ответь на русском языке одним JSON-объектом и ничем больше:
${RESPONSE_SHAPE}
- name фичи: короткое бизнес-название, 2–5 слов;
- description фичи: одно-два простых предложения — что происходит и куда уходят данные;
- name компонента и стока: бизнес-название, 1–4 слова.
Идентификаторы сохраняй в точности. Избегай имён классов и технического жаргона. Если не уверен, держись ближе к техническому смыслу.`,
  en: `You name and explain features of a backend service for readers who are not developers (analysts, managers).
You receive JSON with features (their triggers, the steps through code components and the sinks they reach) and the components and sinks involved.
Use only this input; do not invent behaviour that is not visible in it.

Answer in English with one JSON object and nothing else:
${RESPONSE_SHAPE}
- feature name: a short business name, 2-5 words;
- feature description: one or two plain sentences: what happens and where the data goes;
- component and sink name: a business name, 1-4 words.
Keep ids exactly as given. Avoid class names and technical jargon. If unsure, stay close to the technical meaning.`,
};

export const describePrompt = (lang: string): string => DESCRIBE[lang] ?? DESCRIBE.en;
