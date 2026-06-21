const QUESTION_RE = /^\s*(\d+)\s*[.．。、\)]?\s*(.+)$/u;
const OPTION_RE = /^\s*([A-Z])(?:\s*[.．。、,:：，\)]\s*|\s+)?(.+)$/u;
const SECTION_RE = /^\s*(?:[一二三四五六七八九十]+(?:\s*[.．、\)])?|第[一二三四五六七八九十]+部分)\s*$/u;

const INSTRUCTION_PATTERNS = [
  "单项选择题",
  "多项选择题",
  "单选题",
  "多选题",
  "判断题",
  "填空题",
  "简答题",
  "多选均",
  "不算分数",
];

function normalizeSpacing(text) {
  return text.replace(/\s+/gu, " ").trim();
}

function isInstructionLine(line) {
  if (!line) return false;
  const compact = line.replace(/\s+/gu, "");
  if (INSTRUCTION_PATTERNS.some((pattern) => compact === pattern || compact.startsWith(`${pattern}（`) || compact.startsWith(`${pattern}(`))) {
    return true;
  }

  return /(?:单项|多项|单选|多选|判断|填空|简答)选择?题[:：]/u.test(line);
}

function uniqueLetters(value) {
  return [...new Set((value || "").replace(/\s+/gu, "").split("").filter((char) => /[A-Z]/u.test(char)))].sort();
}

function hasMeaningfulText(value) {
  return /[\p{L}\p{N}\u4e00-\u9fff]/u.test(value ?? "");
}

function extractAnswerAndStem(rawStem) {
  let stem = normalizeSpacing(rawStem);
  let answer = [];

  const bracketGroups = [...stem.matchAll(/[【\[]([^】\]]*)[】\]]/gu)];
  if (bracketGroups.length) {
    answer = uniqueLetters(bracketGroups.map((match) => match[1]).join(""));
    stem = normalizeSpacing(stem.replace(/[【\[][^】\]]*[】\]]/gu, " "));
    return { stem, answer };
  }

  const tailParenAnswer = stem.match(/[（(]\s*([A-Z.\s]{1,12})\s*[)）]\s*$/u);
  if (tailParenAnswer) {
    const parsed = uniqueLetters(tailParenAnswer[1]);
    if (parsed.length) {
      answer = parsed;
      stem = normalizeSpacing(stem.slice(0, tailParenAnswer.index));
      return { stem, answer };
    }
  }

  const beforeEmptyParenAnswer = stem.match(/([A-Z]{1,6})\s*[（(]\s*[)）]\s*$/u);
  if (beforeEmptyParenAnswer) {
    answer = uniqueLetters(beforeEmptyParenAnswer[1]);
    stem = normalizeSpacing(stem.slice(0, beforeEmptyParenAnswer.index));
    return { stem, answer };
  }

  const rightParenTailAnswer = stem.match(/([A-Z]{1,6})\)\s*$/u);
  if (rightParenTailAnswer) {
    answer = uniqueLetters(rightParenTailAnswer[1]);
    stem = normalizeSpacing(stem.slice(0, rightParenTailAnswer.index));
    return { stem, answer };
  }

  const plainTailAnswer = stem.match(/([A-Z]{1,6})\s*$/u);
  if (plainTailAnswer) {
    const parsed = uniqueLetters(plainTailAnswer[1]);
    const prefix = stem.slice(0, plainTailAnswer.index);
    if (parsed.length && /[\u4e00-\u9fff)\]）】\s]$/u.test(prefix)) {
      answer = parsed;
      stem = normalizeSpacing(prefix);
      return { stem, answer };
    }
  }

  return { stem, answer };
}

function createFingerprint(question) {
  const content = [
    question.stem,
    question.options.map((option) => `${option.key}:${option.text}`).join("|"),
    question.answer.join(""),
  ].join("||");

  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return `q_${(hash >>> 0).toString(16)}`;
}

export function hashText(text) {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
  }
  return `src_${(hash >>> 0).toString(16)}`;
}

export function buildDeduplicatedQuestions(questions) {
  const deduplicatedQuestions = [];
  const fingerprintMap = new Map();

  for (const question of questions) {
    const fingerprint = question.fingerprint ?? createFingerprint(question);
    if (fingerprintMap.has(fingerprint)) {
      continue;
    }

    const sourceNos = question.sourceNos ?? [question.sourceNo];
    const duplicateCount = question.duplicateCount ?? sourceNos.length;
    const normalized = {
      ...question,
      id: deduplicatedQuestions.length + 1,
      fingerprint,
      sourceNos: [...sourceNos],
      duplicateCount,
    };

    fingerprintMap.set(fingerprint, normalized);
    deduplicatedQuestions.push(normalized);
  }

  return deduplicatedQuestions;
}

export function parseQuestionBank(rawText) {
  const lines = rawText
    .replace(/\uFEFF/gu, "")
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean);

  const questions = [];
  let currentQuestion = null;
  let pendingOption = null;

  function finalizeCurrentQuestion() {
    if (!currentQuestion) return;

    currentQuestion.stem = normalizeSpacing(currentQuestion.stem);
    currentQuestion.options = currentQuestion.options.map((option) => ({
      key: option.key,
      text: normalizeSpacing(option.text),
    }));
    currentQuestion.answer = uniqueLetters(currentQuestion.answer.join(""));
    currentQuestion.type = currentQuestion.answer.length > 1 ? "multi" : "single";

    if (currentQuestion.stem && currentQuestion.options.length >= 2 && currentQuestion.answer.length >= 1) {
      currentQuestion.fingerprint = createFingerprint(currentQuestion);
      questions.push(currentQuestion);
    }

    currentQuestion = null;
    pendingOption = null;
  }

  for (const line of lines) {
    if (SECTION_RE.test(line) || isInstructionLine(line)) {
      finalizeCurrentQuestion();
      continue;
    }

    const questionMatch = line.match(QUESTION_RE);
    if (questionMatch) {
      finalizeCurrentQuestion();
      const [, sourceNo, rawStem] = questionMatch;
      const { stem, answer } = extractAnswerAndStem(rawStem);
      currentQuestion = {
        sourceNo,
        stem,
        answer,
        options: [],
      };
      pendingOption = null;
      continue;
    }

    if (!currentQuestion) {
      continue;
    }

    const optionMatch = line.match(OPTION_RE);
    if (optionMatch) {
      const [, key, text] = optionMatch;
      if (!hasMeaningfulText(text)) {
        continue;
      }
      const option = {
        key,
        text: text.trim(),
      };
      currentQuestion.options.push(option);
      pendingOption = option;
      continue;
    }

    if (line === "的需要" || line.startsWith("认为正确的答案")) {
      continue;
    }

    if (pendingOption) {
      pendingOption.text = normalizeSpacing(`${pendingOption.text} ${line}`);
    } else {
      currentQuestion.stem = normalizeSpacing(`${currentQuestion.stem} ${line}`);
    }
  }

  finalizeCurrentQuestion();

  const sourceNosByFingerprint = new Map();
  for (const question of questions) {
    const fingerprint = question.fingerprint;
    const sourceNos = sourceNosByFingerprint.get(fingerprint) ?? [];
    sourceNos.push(question.sourceNo);
    sourceNosByFingerprint.set(fingerprint, sourceNos);
  }

  return questions.map((question, index) => {
    const sourceNos = sourceNosByFingerprint.get(question.fingerprint) ?? [question.sourceNo];
    return {
      id: index + 1,
      sourceNo: question.sourceNo,
      sourceNos: [...sourceNos],
      stem: question.stem,
      answer: question.answer,
      type: question.type,
      options: question.options,
      fingerprint: question.fingerprint,
      duplicateCount: sourceNos.length,
    };
  });
}
