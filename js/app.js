import {
  addAttempt,
  clearAllProgress,
  clearEntireDatabase,
  createDefaultState,
  getAllAttempts,
  getAllQuestions,
  getAllStates,
  getAttemptsByQuestionId,
  getMeta,
  openDatabase,
  putState,
  replaceQuestionBank,
  restartMainProgress,
  restoreProgressSnapshot,
  seedDatabase,
  setMeta,
} from "./db.js";
import { buildDeduplicatedQuestions, hashText, parseQuestionBank } from "./parser.js";
import { applyManualTagRemoval, evaluateSubmission } from "./state-machine.js";

const QUESTION_BANK_STRUCTURE_VERSION = 3;
const RAW_QUESTIONS_META_KEY = "rawQuestions";

const modeLabels = {
  main: "主题库",
  wrong: "做错了",
  uncertain: "不确定",
  review: "复盘",
  stats: "统计",
};

const elements = {
  appStatus: document.querySelector("#app-status"),
  emptyState: document.querySelector("#empty-state"),
  emptyStateText: document.querySelector("#empty-state-text"),
  questionPanel: document.querySelector("#question-panel"),
  questionForm: document.querySelector("#question-form"),
  questionTitle: document.querySelector("#question-title"),
  questionCounter: document.querySelector("#question-counter"),
  questionSourceMeta: document.querySelector("#question-source-meta"),
  questionOptions: document.querySelector("#question-options"),
  modeTitle: document.querySelector("#mode-title"),
  resultPanel: document.querySelector("#result-panel"),
  noteEditorPanel: document.querySelector("#note-editor-panel"),
  noteEditorStatus: document.querySelector("#note-editor-status"),
  noteInput: document.querySelector("#question-note-input"),
  saveNoteButton: document.querySelector("#save-note-button"),
  markUncertainCheckbox: document.querySelector("#mark-uncertain-checkbox"),
  submitAnswerButton: document.querySelector("#submit-answer-button"),
  nextQuestionButton: document.querySelector("#next-question-button"),
  copyQuestionButton: document.querySelector("#copy-question-button"),
  showAnswerButton: document.querySelector("#show-answer-button"),
  modeButtons: [...document.querySelectorAll(".mode-button")],
  summaryStats: document.querySelector("#summary-stats"),
  searchInput: document.querySelector("#search-input"),
  filterToolbar: document.querySelector("#filter-toolbar"),
  filterSummary: document.querySelector("#filter-summary"),
  filterList: document.querySelector("#filter-list"),
  duplicateSummary: document.querySelector("#duplicate-summary"),
  duplicateList: document.querySelector("#duplicate-list"),
  importFileInput: document.querySelector("#import-file-input"),
  importProgressInput: document.querySelector("#import-progress-input"),
  sourceStatus: document.querySelector("#source-status"),
  backupStatus: document.querySelector("#backup-status"),
  exportProgressButton: document.querySelector("#export-progress-button"),
  reviewForm: document.querySelector("#review-form"),
  reviewQuestionId: document.querySelector("#review-question-id"),
  reviewQuickList: document.querySelector("#review-quick-list"),
  reviewPanel: document.querySelector("#review-panel"),
  reviewTitle: document.querySelector("#review-title"),
  reviewSubtitle: document.querySelector("#review-subtitle"),
  reviewTags: document.querySelector("#review-tags"),
  reviewAnswerBlock: document.querySelector("#review-answer-block"),
  reviewAttempts: document.querySelector("#review-attempts"),
  statsPanel: document.querySelector("#stats-panel"),
  statsSubtitle: document.querySelector("#stats-subtitle"),
  statsCards: document.querySelector("#stats-cards"),
  statsDetails: document.querySelector("#stats-details"),
  exportWrongMdButton: document.querySelector("#export-wrong-md-button"),
  exportWrongPdfButton: document.querySelector("#export-wrong-pdf-button"),
  exportUncertainMdButton: document.querySelector("#export-uncertain-md-button"),
  exportUncertainPdfButton: document.querySelector("#export-uncertain-pdf-button"),
  removeEverWrongButton: document.querySelector("#remove-ever-wrong-button"),
  removeEverUncertainButton: document.querySelector("#remove-ever-uncertain-button"),
  rebuildBankButton: document.querySelector("#rebuild-bank-button"),
  restartMainButton: document.querySelector("#restart-main-button"),
  resetProgressButton: document.querySelector("#reset-progress-button"),
  confirmModal: document.querySelector("#confirm-modal"),
  confirmModalTitle: document.querySelector("#confirm-modal-title"),
  confirmModalMessage: document.querySelector("#confirm-modal-message"),
  confirmModalCancel: document.querySelector("#confirm-modal-cancel"),
  confirmModalConfirm: document.querySelector("#confirm-modal-confirm"),
  printExportRoot: document.querySelector("#print-export-root"),
};

const appState = {
  database: null,
  questions: [],
  stateMap: new Map(),
  currentMode: "main",
  currentQuestionId: null,
  currentQuestion: null,
  reviewQuestionId: null,
  reviewAnswerVisible: false,
  pendingResult: null,
  sourceInfo: null,
  currentFilter: "all",
  searchKeyword: "",
  currentQuestionSubmitted: false,
  activeConfirmAction: null,
};

function setBanner(message, tone = "info") {
  elements.appStatus.textContent = message;
  elements.appStatus.className = `banner banner-${tone}`;
}

function showEmptyState(message) {
  elements.emptyState.classList.remove("is-hidden");
  elements.emptyStateText.textContent = message;
  elements.questionPanel.classList.add("is-hidden");
  elements.reviewPanel.classList.add("is-hidden");
}

function hideEmptyState() {
  elements.emptyState.classList.add("is-hidden");
}

function openConfirmModal({ title, message, tone = "danger", onConfirm }) {
  appState.activeConfirmAction = onConfirm;
  elements.confirmModalTitle.textContent = title;
  elements.confirmModalMessage.textContent = message;
  elements.confirmModalConfirm.className = tone === "danger" ? "danger-button" : "primary-button";
  elements.confirmModalConfirm.textContent = "确认";
  elements.confirmModal.classList.remove("is-hidden");
  elements.confirmModal.setAttribute("aria-hidden", "false");
}

function closeConfirmModal() {
  appState.activeConfirmAction = null;
  elements.confirmModal.classList.add("is-hidden");
  elements.confirmModal.setAttribute("aria-hidden", "true");
}

function getStateForQuestion(questionId) {
  return appState.stateMap.get(questionId) ?? createDefaultState(questionId);
}

function saveStateLocally(state) {
  appState.stateMap.set(state.questionId, state);
}

function formatAnswer(answer) {
  return answer.join("、");
}

function normalizeNote(value) {
  const raw = typeof value === "string" ? value : "";
  const normalized = raw.replace(/\r\n/gu, "\n");
  return normalized.trim() ? normalized.trim() : "";
}

function escapeMarkdownText(text) {
  return String(text ?? "").replaceAll("\r\n", "\n").replace(/[\\`*_{}[\]()#+\-.!|>]/gu, "\\$&");
}

function formatNoteForHtml(note) {
  return escapeHtml(note).replaceAll("\n", "<br>");
}

function getQuestionNote(questionId) {
  return normalizeNote(getStateForQuestion(questionId).note);
}

function hideNoteEditor() {
  elements.noteEditorPanel.classList.add("is-hidden");
  elements.noteEditorStatus.textContent = "";
  elements.noteInput.value = "";
}

function showNoteEditor({ note, statusText = "" }) {
  elements.noteEditorPanel.classList.remove("is-hidden");
  elements.noteInput.value = note;
  elements.noteEditorStatus.textContent = statusText;
}

function createDefaultViewState(questions) {
  return {
    currentMode: "main",
    focusByMode: {
      main: questions[0]?.id ?? null,
      wrong: null,
      uncertain: null,
      review: questions[0]?.id ?? null,
    },
    reviewAnswerVisible: false,
  };
}

function prepareQuestionBank(rawText) {
  const rawQuestions = parseQuestionBank(rawText);
  const questions = buildDeduplicatedQuestions(rawQuestions);
  return { rawQuestions, questions };
}

function buildQuestionGroupsByFingerprint(questions) {
  const groups = new Map();

  for (const question of questions) {
    const key = question.fingerprint ?? `${question.stem}::${question.answer.join("")}`;
    const group = groups.get(key) ?? [];
    group.push(question);
    groups.set(key, group);
  }

  return groups;
}

function cloneStateForQuestion(state, questionId) {
  return {
    ...createDefaultState(questionId),
    ...state,
    questionId,
    lastSelected: [...(state?.lastSelected ?? [])],
  };
}

function sanitizeQuestionId(value, validQuestionIds) {
  return validQuestionIds.has(value) ? value : null;
}

function compareIsoAsc(leftValue, rightValue) {
  const left = leftValue ?? "";
  const right = rightValue ?? "";
  if (left && right && left !== right) {
    return left.localeCompare(right);
  }
  if (left && !right) return -1;
  if (!left && right) return 1;
  return 0;
}

function compareIsoDesc(leftValue, rightValue) {
  return compareIsoAsc(rightValue, leftValue);
}

function pickRepresentativeAttemptEntry(attemptEntries) {
  if (!attemptEntries.length) return null;

  const wrongAttemptEntry = [...attemptEntries]
    .filter(({ attempt }) => attempt.isCorrect === false)
    .sort((left, right) => {
      const timeCompare = compareIsoDesc(left.attempt.submittedAt, right.attempt.submittedAt);
      if (timeCompare !== 0) return timeCompare;
      return right.order - left.order;
    })[0];

  if (wrongAttemptEntry) {
    return wrongAttemptEntry;
  }

  return [...attemptEntries].sort((left, right) => {
    const timeCompare = compareIsoAsc(left.attempt.submittedAt, right.attempt.submittedAt);
    if (timeCompare !== 0) return timeCompare;
    return left.order - right.order;
  })[0];
}

function pickRepresentativeStateEntry(stateEntries) {
  if (!stateEntries.length) return null;

  const wrongStateEntry = [...stateEntries]
    .filter(({ state }) => state.lastCorrect === false && state.lastSubmittedAt)
    .sort((left, right) => {
      const timeCompare = compareIsoDesc(left.state.lastSubmittedAt, right.state.lastSubmittedAt);
      if (timeCompare !== 0) return timeCompare;
      return right.order - left.order;
    })[0];

  if (wrongStateEntry) {
    return wrongStateEntry;
  }

  const answeredStateEntry = [...stateEntries]
    .filter(({ state }) =>
      Boolean(state.lastSubmittedAt)
      || Boolean(state.mainDone)
      || Boolean(state.lastSelected?.length)
      || state.lastCorrect != null,
    )
    .sort((left, right) => left.order - right.order)[0];

  return answeredStateEntry ?? stateEntries[0];
}

function buildMergedDuplicateState({ stateEntries, attemptEntries, questionId }) {
  const representativeAttemptEntry = pickRepresentativeAttemptEntry(attemptEntries);
  const representativeStateEntry = representativeAttemptEntry
    ? stateEntries.find(({ oldQuestion }) => oldQuestion.id === representativeAttemptEntry.oldQuestion.id)
      ?? pickRepresentativeStateEntry(stateEntries)
    : pickRepresentativeStateEntry(stateEntries);

  const representativeState = representativeStateEntry?.state ?? null;
  const representativeAttempt = representativeAttemptEntry?.attempt ?? null;

  const fallbackNote = stateEntries
    .map(({ state }) => normalizeNote(state.note))
    .find(Boolean) ?? "";

  const mainDone = stateEntries.some(({ state }) => Boolean(state.mainDone))
    || attemptEntries.some(({ attempt }) => attempt.mode === "main")
    || Boolean(representativeAttempt)
    || Boolean(representativeState?.mainDone);

  const everWrong = attemptEntries.some(({ attempt }) => attempt.isCorrect === false)
    || stateEntries.some(({ state }) => Boolean(state.everWrong) || state.lastCorrect === false || Number(state.wrongCount ?? 0) > 0);
  const everUncertain = attemptEntries.some(({ attempt }) => Boolean(attempt.markedUncertain))
    || stateEntries.some(({ state }) => Boolean(state.everUncertain));

  let lastSelected = representativeState?.lastSelected ?? [];
  let lastCorrect = representativeState?.lastCorrect ?? null;
  let lastMode = representativeState?.lastMode ?? null;
  let lastSubmittedAt = representativeState?.lastSubmittedAt ?? null;
  let wrongBookOrderAt = representativeState?.wrongBookOrderAt ?? null;
  let uncertainBookOrderAt = representativeState?.uncertainBookOrderAt ?? null;
  let inWrongBook = Boolean(representativeState?.inWrongBook);
  let inUncertainBook = Boolean(representativeState?.inUncertainBook) && !inWrongBook;
  let attemptCount = Number(representativeState?.attemptCount ?? 0);
  let wrongCount = Number(representativeState?.wrongCount ?? 0);

  if (representativeAttempt) {
    lastSelected = [...(representativeAttempt.selected ?? [])];
    lastCorrect = Boolean(representativeAttempt.isCorrect);
    lastMode = representativeAttempt.mode ?? null;
    lastSubmittedAt = representativeAttempt.submittedAt ?? null;
    attemptCount = 1;
    wrongCount = representativeAttempt.isCorrect ? 0 : 1;
    inWrongBook = !representativeAttempt.isCorrect;
    inUncertainBook = representativeAttempt.isCorrect && Boolean(representativeAttempt.markedUncertain);
    wrongBookOrderAt = inWrongBook ? representativeAttempt.submittedAt ?? null : null;
    uncertainBookOrderAt = inUncertainBook ? representativeAttempt.submittedAt ?? null : null;
  } else if (lastSubmittedAt || mainDone) {
    attemptCount = attemptCount > 0 ? 1 : Number(Boolean(lastSubmittedAt || mainDone));
    wrongCount = lastCorrect === false || inWrongBook ? 1 : 0;
    wrongBookOrderAt = inWrongBook ? representativeState?.wrongBookOrderAt ?? lastSubmittedAt : null;
    uncertainBookOrderAt = inUncertainBook ? representativeState?.uncertainBookOrderAt ?? lastSubmittedAt : null;
  }

  if (inWrongBook) {
    inUncertainBook = false;
    uncertainBookOrderAt = null;
  }

  return {
    ...createDefaultState(questionId),
    questionId,
    mainDone,
    lastSelected: [...lastSelected],
    lastCorrect,
    lastMode,
    lastSubmittedAt,
    note: normalizeNote(representativeState?.note) || fallbackNote,
    wrongBookOrderAt,
    uncertainBookOrderAt,
    inWrongBook,
    inUncertainBook,
    everWrong,
    everUncertain,
    wrongCount,
    attemptCount,
  };
}

function mergeStatesForSingleQuestion({ stateEntries, attemptEntries, questionId }) {
  if (!stateEntries.length) {
    return createDefaultState(questionId);
  }

  if (stateEntries.length === 1) {
    return cloneStateForQuestion(stateEntries[0].state, questionId);
  }

  return buildMergedDuplicateState({ stateEntries, attemptEntries, questionId });
}

function mapOldQuestionIdToNewQuestionId(oldQuestionId, { oldQuestionMap, firstNewQuestionByFingerprint, newGroups, validQuestionIds }) {
  const oldQuestion = oldQuestionMap.get(oldQuestionId);
  if (oldQuestion) {
    const mappedQuestion = firstNewQuestionByFingerprint.get(oldQuestion.fingerprint)
      ?? (newGroups.get(oldQuestion.fingerprint) ?? [])[0];

    return mappedQuestion?.id ?? null;
  }

  return sanitizeQuestionId(oldQuestionId, validQuestionIds);
}

function migrateQuestionBankData({ oldQuestions, oldStates, oldAttempts, oldViewState, newQuestions }) {
  const oldStateMap = new Map((oldStates ?? []).map((state) => [state.questionId, state]));
  const oldQuestionMap = new Map((oldQuestions ?? []).map((question) => [question.id, question]));
  const oldGroups = buildQuestionGroupsByFingerprint(oldQuestions ?? []);
  const newGroups = buildQuestionGroupsByFingerprint(newQuestions);
  const questionOrderMap = new Map((oldQuestions ?? []).map((question, index) => [question.id, index]));
  const deduplicatedNewQuestions = buildDeduplicatedQuestions(newQuestions);
  const firstNewQuestionByFingerprint = new Map(
    deduplicatedNewQuestions.map((question) => [question.fingerprint, question]),
  );

  const attemptEntries = (oldAttempts ?? [])
    .map((attempt, index) => {
      const oldQuestion = oldQuestionMap.get(attempt.questionId);
      if (!oldQuestion) return null;

      return {
        attempt,
        oldQuestion,
        order: index,
      };
    })
    .filter(Boolean);

  const attemptGroups = new Map();
  for (const entry of attemptEntries) {
    const group = attemptGroups.get(entry.oldQuestion.fingerprint) ?? [];
    group.push(entry);
    attemptGroups.set(entry.oldQuestion.fingerprint, group);
  }

  const migratedStates = [];
  for (const question of newQuestions) {
    const oldGroupQuestions = oldGroups.get(question.fingerprint) ?? [];
    const stateEntries = oldGroupQuestions
      .map((oldQuestion) => ({
        oldQuestion,
        state: oldStateMap.get(oldQuestion.id) ?? createDefaultState(oldQuestion.id),
        order: questionOrderMap.get(oldQuestion.id) ?? Number.MAX_SAFE_INTEGER,
      }));
    const candidateAttempts = attemptGroups.get(question.fingerprint) ?? [];

    if (stateEntries.length) {
      migratedStates.push(mergeStatesForSingleQuestion({
        stateEntries,
        attemptEntries: candidateAttempts,
        questionId: question.id,
      }));
    } else {
      migratedStates.push(createDefaultState(question.id));
    }
  }

  const selectedAttemptEntries = new Set();
  for (const [fingerprint, groupEntries] of attemptGroups.entries()) {
    const oldGroupSize = (oldGroups.get(fingerprint) ?? []).length;
    if (oldGroupSize > 1) {
      const representativeAttemptEntry = pickRepresentativeAttemptEntry(groupEntries);
      if (representativeAttemptEntry) {
        selectedAttemptEntries.add(representativeAttemptEntry);
      }
      continue;
    }

    for (const entry of groupEntries) {
      selectedAttemptEntries.add(entry);
    }
  }

  const migratedAttempts = attemptEntries
    .filter((entry) => selectedAttemptEntries.has(entry))
    .map((entry) => {
      const mappedQuestion = firstNewQuestionByFingerprint.get(entry.oldQuestion.fingerprint)
        ?? (newGroups.get(entry.oldQuestion.fingerprint) ?? [])[0];

      if (!mappedQuestion) return null;

      return {
        ...entry.attempt,
        questionId: mappedQuestion.id,
        selected: [...(entry.attempt.selected ?? [])],
        answer: [...(entry.attempt.answer ?? [])],
      };
    })
    .filter(Boolean);

  const validQuestionIds = new Set(newQuestions.map((question) => question.id));
  const defaultViewState = createDefaultViewState(newQuestions);
  const fallbackReviewId = newQuestions[0]?.id ?? null;

  const migratedViewState = {
    currentMode: ["main", "wrong", "uncertain", "review", "stats"].includes(oldViewState?.currentMode)
      ? oldViewState.currentMode
      : defaultViewState.currentMode,
    focusByMode: {
      main: mapOldQuestionIdToNewQuestionId(oldViewState?.focusByMode?.main, {
        oldQuestionMap,
        firstNewQuestionByFingerprint,
        newGroups,
        validQuestionIds,
      }) ?? defaultViewState.focusByMode.main,
      wrong: mapOldQuestionIdToNewQuestionId(oldViewState?.focusByMode?.wrong, {
        oldQuestionMap,
        firstNewQuestionByFingerprint,
        newGroups,
        validQuestionIds,
      }),
      uncertain: mapOldQuestionIdToNewQuestionId(oldViewState?.focusByMode?.uncertain, {
        oldQuestionMap,
        firstNewQuestionByFingerprint,
        newGroups,
        validQuestionIds,
      }),
      review: mapOldQuestionIdToNewQuestionId(oldViewState?.focusByMode?.review, {
        oldQuestionMap,
        firstNewQuestionByFingerprint,
        newGroups,
        validQuestionIds,
      }) ?? fallbackReviewId,
    },
    reviewAnswerVisible: Boolean(oldViewState?.reviewAnswerVisible),
  };

  if (migratedViewState.currentMode === "wrong" && migratedViewState.focusByMode.wrong == null) {
    migratedViewState.currentMode = "main";
  }
  if (migratedViewState.currentMode === "uncertain" && migratedViewState.focusByMode.uncertain == null) {
    migratedViewState.currentMode = "main";
  }

  return {
    states: migratedStates,
    attempts: migratedAttempts,
    viewState: migratedViewState,
  };
}

function getDisplayQuestionIdsForMode(mode) {
  if (mode === "main") {
    return appState.questions.map((question) => question.id);
  }

  return getQuestionIdsForMode(mode);
}

function buildQuestionCopyText() {
  if (!appState.currentQuestion) return "";

  const question = appState.currentQuestion;
  const lines = [`第 ${question.id} 题：${question.stem}`];

  for (const option of question.options) {
    lines.push(`${option.key}. ${option.text}`);
  }

  if (appState.currentQuestionSubmitted && appState.pendingResult) {
    lines.push("");
    lines.push(`我选的答案：${appState.pendingResult.selected.length ? formatAnswer(appState.pendingResult.selected) : "未选择"}`);
    lines.push(`正确答案：${formatAnswer(appState.pendingResult.answer)}`);
  }

  return lines.join("\n");
}

async function handleCopyQuestion() {
  const text = buildQuestionCopyText();
  if (!text) {
    setBanner("当前没有可复制的题目内容。", "warning");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    setBanner("题目内容已复制到剪贴板。", "success");
  } catch (error) {
    console.error(error);
    setBanner("复制失败。请确认浏览器允许访问剪贴板。", "danger");
  }
}

function formatDateTime(value) {
  if (!value) return "暂无";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function computeSummary() {
  const total = appState.questions.length;
  let mainDone = 0;
  let wrongActive = 0;
  let uncertainActive = 0;
  let everWrong = 0;
  let everUncertain = 0;

  for (const question of appState.questions) {
    const state = getStateForQuestion(question.id);
    if (state.mainDone) mainDone += 1;
    if (state.inWrongBook) wrongActive += 1;
    if (state.inUncertainBook) uncertainActive += 1;
    if (state.everWrong) everWrong += 1;
    if (state.everUncertain) everUncertain += 1;
  }

  return {
    total,
    mainDone,
    mainRemaining: Math.max(total - mainDone, 0),
    wrongActive,
    uncertainActive,
    everWrong,
    everUncertain,
  };
}

function renderSummary() {
  const summary = computeSummary();
  const percent = summary.total ? Math.round((summary.mainDone / summary.total) * 100) : 0;

  const cards = [
    { label: "主题库进度", value: `${summary.mainDone} / ${summary.total}`, note: `完成率 ${percent}%` },
    { label: "剩余未做", value: `${summary.mainRemaining}`, note: "按主题库顺序继续" },
    { label: "做错了题库", value: `${summary.wrongActive}`, note: `累计曾错 ${summary.everWrong}` },
    { label: "不确定题库", value: `${summary.uncertainActive}`, note: `累计曾不会 ${summary.everUncertain}` },
  ];

  elements.summaryStats.innerHTML = cards
    .map(
      (card) => `
        <article class="summary-card">
          <span>${card.label}</span>
          <strong>${card.value}</strong>
          <div class="summary-note">${card.note}</div>
        </article>
      `,
    )
    .join("");

  renderReviewQuickList();
  renderFilterList();
  renderDuplicateList();
}

function downloadTextFile(content, filename, mimeType = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getExportQuestions(kind) {
  if (kind === "wrong") {
    return appState.questions.filter((question) => getStateForQuestion(question.id).everWrong);
  }

  return appState.questions.filter((question) => getStateForQuestion(question.id).everUncertain);
}

function buildMarkdownExport(kind) {
  const questions = getExportQuestions(kind);
  const title = kind === "wrong" ? "错题导出" : "不确定题导出";
  const lines = [`# ${title}`, "", `共 ${questions.length} 题`, ""];

  for (const question of questions) {
    const note = getQuestionNote(question.id);
    lines.push(`## 第 ${question.id} 题`);
    lines.push(question.stem);
    lines.push("");
    for (const option of question.options) {
      lines.push(`- ${option.key}. ${option.text}`);
    }
    lines.push("");
    lines.push("<details>");
    lines.push("<summary>查看答案</summary>");
    lines.push("");
    lines.push(`正确答案：${formatAnswer(question.answer)}`);
    if (note) {
      lines.push("");
      lines.push("备注：");
      lines.push(escapeMarkdownText(note));
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  return lines.join("\n");
}

function buildPrintExportHtml(kind) {
  const questions = getExportQuestions(kind);
  const title = kind === "wrong" ? "错题打印导出" : "不确定题打印导出";
  const items = questions
    .map((question) => {
      const note = getQuestionNote(question.id);
      const optionsHtml = question.options
        .map((option) => `<p>${option.key}. ${escapeHtml(option.text)}</p>`)
        .join("");
      const noteHtml = note
        ? `<div class="print-export-note"><strong>备注：</strong>${formatNoteForHtml(note)}</div>`
        : "";

      return `
        <article class="print-export-item">
          <p>第 ${question.id} 题 ${escapeHtml(question.stem)}</p>
          ${optionsHtml}
          <p class="print-export-answer">答案：${escapeHtml(formatAnswer(question.answer))}</p>
          ${noteHtml}
        </article>
      `;
    })
    .join("");

  return `
    <section class="print-export-page">
      <h1>${escapeHtml(title)}</h1>
      ${items || "<p>暂无可导出的题目。</p>"}
    </section>
  `;
}

function exportMarkdown(kind) {
  const questions = getExportQuestions(kind);
  if (!questions.length) {
    setBanner(`当前没有可导出的${kind === "wrong" ? "错题" : "不确定题"}。`, "warning");
    return;
  }

  const content = buildMarkdownExport(kind);
  const filename = kind === "wrong" ? "wrong-questions.md" : "uncertain-questions.md";
  downloadTextFile(content, filename, "text/markdown;charset=utf-8");
  setBanner(`${kind === "wrong" ? "错题" : "不确定题"} Markdown 导出完成。`, "success");
}

function exportPdf(kind) {
  const questions = getExportQuestions(kind);
  if (!questions.length) {
    setBanner(`当前没有可导出的${kind === "wrong" ? "错题" : "不确定题"}。`, "warning");
    return;
  }

  const html = buildPrintExportHtml(kind);
  elements.printExportRoot.innerHTML = html;
  elements.printExportRoot.classList.remove("is-hidden");
  elements.printExportRoot.setAttribute("aria-hidden", "false");

  window.print();

  window.setTimeout(() => {
    elements.printExportRoot.innerHTML = "";
    elements.printExportRoot.classList.add("is-hidden");
    elements.printExportRoot.setAttribute("aria-hidden", "true");
  }, 300);

  setBanner(`${kind === "wrong" ? "错题" : "不确定题"} PDF 打印视图已打开。请在浏览器打印对话框中保存为 PDF。`, "success");
}

function renderReviewQuickList() {
  if (!elements.reviewQuickList) return;

  elements.reviewQuickList.innerHTML = appState.questions
    .map((question) => {
      const state = getStateForQuestion(question.id);
      const classNames = [
        "quick-chip",
        question.id === appState.reviewQuestionId ? "is-active" : "",
        state.mainDone ? "is-done" : "",
        state.inWrongBook || state.everWrong ? "has-wrong" : "",
        state.inUncertainBook || state.everUncertain ? "has-uncertain" : "",
      ].filter(Boolean).join(" ");

      return `
        <button type="button" class="${classNames}" data-review-id="${question.id}">
          #${question.id}
        </button>
      `;
    })
    .join("");
}

function matchesFilter(state, filter) {
  if (filter === "all") return true;
  if (filter === "undone") return !state.mainDone;
  if (filter === "done") return state.mainDone;
  if (filter === "wrong-active") return state.inWrongBook;
  if (filter === "uncertain-active") return state.inUncertainBook;
  if (filter === "ever-wrong") return state.everWrong;
  if (filter === "ever-uncertain") return state.everUncertain;
  return true;
}

function getFilterLabel(filter) {
  const labels = {
    all: "全部题目",
    undone: "未做题",
    done: "已做题",
    "wrong-active": "当前错题",
    "uncertain-active": "当前不确定题",
    "ever-wrong": "曾经做错",
    "ever-uncertain": "曾经不会",
  };
  return labels[filter] ?? "全部题目";
}

function renderFilterList() {
  if (!elements.filterList || !elements.filterToolbar) return;

  const filteredQuestions = appState.questions.filter((question) => {
    const state = getStateForQuestion(question.id);
    const matchesState = matchesFilter(state, appState.currentFilter);
    const keyword = appState.searchKeyword.trim().toLowerCase();
    const haystack = [
      question.stem,
      question.sourceNo,
      ...(question.sourceNos ?? []),
      ...question.options.map((option) => option.text),
    ].join(" ").toLowerCase();

    const matchesKeyword = keyword ? haystack.includes(keyword) : true;
    return matchesState && matchesKeyword;
  });

  for (const chip of elements.filterToolbar.querySelectorAll("[data-filter]")) {
    chip.classList.toggle("is-active", chip.dataset.filter === appState.currentFilter);
  }

  const keywordText = appState.searchKeyword.trim() ? `，关键词“${appState.searchKeyword.trim()}”` : "";
  elements.filterSummary.textContent = `${getFilterLabel(appState.currentFilter)}${keywordText}：共 ${filteredQuestions.length} 题`;

  elements.filterList.innerHTML = filteredQuestions.length
    ? filteredQuestions
        .map((question) => {
          const state = getStateForQuestion(question.id);
          const tags = [
            state.mainDone ? "已做" : "未做",
            state.inWrongBook ? "当前错题" : "",
            state.inUncertainBook ? "当前不确定" : "",
            state.everWrong ? "曾错" : "",
            state.everUncertain ? "曾不会" : "",
          ].filter(Boolean).join(" · ");

          return `
            <button type="button" class="filter-item" data-question-id="${question.id}">
              <strong>#${question.id} ${question.stem}</strong>
              <div class="filter-item-meta">原题号 ${question.sourceNos?.join("、") ?? question.sourceNo} · ${question.type === "multi" ? "多选" : "单选"} · ${question.duplicateCount > 1 ? `重复出现 ${question.duplicateCount} 次 · ` : ""}${tags || "暂无标签"}</div>
            </button>
          `;
        })
        .join("")
    : `<div class="attempt-card">当前筛选下没有题目。</div>`;
}

function getDuplicateGroups() {
  const seen = new Set();
  const groups = [];

  for (const question of appState.questions) {
    if ((question.duplicateCount ?? 1) <= 1) continue;
    if (seen.has(question.fingerprint)) continue;
    seen.add(question.fingerprint);
    groups.push([question]);
  }

  return groups;
}

function renderDuplicateList() {
  const duplicateGroups = getDuplicateGroups();
  elements.duplicateSummary.textContent = duplicateGroups.length
    ? `已自动合并 ${duplicateGroups.length} 组重复题；当前只保留唯一题目，但会继续展示每组重复题对应的原题号。`
    : "当前没有检测到重复题。";

  elements.duplicateList.innerHTML = duplicateGroups.length
    ? duplicateGroups
        .map((group, index) => {
          const question = group[0];
          return `
            <button type="button" class="filter-item" data-question-id="${question.id}">
              <strong>重复组 ${index + 1}：${question.stem}</strong>
              <div class="filter-item-meta">定位连续编号 #${question.id} · 对应原题号 ${question.sourceNos?.join("、") ?? question.sourceNo} · 共出现 ${question.duplicateCount ?? 1} 次</div>
            </button>
          `;
        })
        .join("")
    : `<div class="attempt-card">没有重复题提示。</div>`;
}

function getQuestionIdsForMode(mode) {
  if (mode === "main") {
    return appState.questions
      .filter((question) => !getStateForQuestion(question.id).mainDone)
      .map((question) => question.id);
  }

  if (mode === "wrong") {
    return appState.questions
      .filter((question) => getStateForQuestion(question.id).inWrongBook)
      .sort((left, right) => {
        const leftState = getStateForQuestion(left.id);
        const rightState = getStateForQuestion(right.id);
        const leftOrder = leftState.wrongBookOrderAt ?? leftState.lastSubmittedAt ?? "";
        const rightOrder = rightState.wrongBookOrderAt ?? rightState.lastSubmittedAt ?? "";
        const timeCompare = leftOrder.localeCompare(rightOrder);
        if (timeCompare !== 0) return timeCompare;
        return left.id - right.id;
      })
      .map((question) => question.id);
  }

  if (mode === "uncertain") {
    return appState.questions
      .filter((question) => getStateForQuestion(question.id).inUncertainBook)
      .sort((left, right) => {
        const leftState = getStateForQuestion(left.id);
        const rightState = getStateForQuestion(right.id);
        const leftOrder = leftState.uncertainBookOrderAt ?? leftState.lastSubmittedAt ?? "";
        const rightOrder = rightState.uncertainBookOrderAt ?? rightState.lastSubmittedAt ?? "";
        const timeCompare = leftOrder.localeCompare(rightOrder);
        if (timeCompare !== 0) return timeCompare;
        return left.id - right.id;
      })
      .map((question) => question.id);
  }

  return appState.questions.map((question) => question.id);
}

function getNextQuestionIdFromPreviousOrder(questionId, ids) {
  const index = ids.indexOf(questionId);
  if (index === -1) return ids[0] ?? null;
  return ids[index + 1] ?? ids[0] ?? null;
}

function getQuestionByIdLocal(questionId) {
  return appState.questions.find((question) => question.id === questionId) ?? null;
}

function getDefaultQuestionIdForMode(mode) {
  const ids = getQuestionIdsForMode(mode);
  return ids.length ? ids[0] : null;
}

async function loadViewState() {
  const stored = (await getMeta(appState.database, "viewState")) ?? {
    currentMode: "main",
    focusByMode: {
      main: getDefaultQuestionIdForMode("main"),
      wrong: getDefaultQuestionIdForMode("wrong"),
      uncertain: getDefaultQuestionIdForMode("uncertain"),
      review: appState.questions[0]?.id ?? null,
    },
    reviewAnswerVisible: false,
  };

  appState.currentMode = stored.currentMode ?? "main";
  appState.reviewAnswerVisible = Boolean(stored.reviewAnswerVisible);

  const mainFocus = stored.focusByMode?.main;
  const wrongFocus = stored.focusByMode?.wrong;
  const uncertainFocus = stored.focusByMode?.uncertain;
  const reviewFocus = stored.focusByMode?.review ?? appState.questions[0]?.id ?? null;

  appState.currentQuestionId = null;
  appState.reviewQuestionId = reviewFocus;

  if (appState.currentMode === "review") {
    appState.reviewQuestionId = reviewFocus;
  } else if (appState.currentMode === "stats") {
    appState.reviewQuestionId = reviewFocus;
  } else {
    const ids = getQuestionIdsForMode(appState.currentMode);
    const requested =
      appState.currentMode === "main" ? mainFocus :
      appState.currentMode === "wrong" ? wrongFocus :
      uncertainFocus;

    appState.currentQuestionId = ids.includes(requested) ? requested : ids[0] ?? null;
  }
}

async function persistViewState() {
  const viewState = {
    currentMode: appState.currentMode,
    focusByMode: {
      main: appState.currentMode === "main" ? appState.currentQuestionId : getDefaultQuestionIdForMode("main"),
      wrong: appState.currentMode === "wrong" ? appState.currentQuestionId : getDefaultQuestionIdForMode("wrong"),
      uncertain: appState.currentMode === "uncertain" ? appState.currentQuestionId : getDefaultQuestionIdForMode("uncertain"),
      review: appState.reviewQuestionId,
    },
    reviewAnswerVisible: appState.reviewAnswerVisible,
  };

  await setMeta(appState.database, "viewState", viewState);
}

function setModeButtons() {
  for (const button of elements.modeButtons) {
    const isActive = button.dataset.mode === appState.currentMode;
    button.classList.toggle("is-active", isActive);
  }
}

function getSelectedAnswers() {
  return [...elements.questionForm.querySelectorAll('input[name="question-option"]:checked')]
    .map((input) => input.value)
    .sort();
}

function renderQuestion(question) {
  if (appState.pendingResult?.questionId !== question.id) {
    appState.pendingResult = null;
  }
  appState.currentQuestion = question;
  if (!appState.currentQuestionSubmitted || appState.pendingResult?.questionId !== question.id) {
    appState.currentQuestionSubmitted = false;
  }
  const state = getStateForQuestion(question.id);
  const modeIds = getDisplayQuestionIdsForMode(appState.currentMode);
  const modeIndex = modeIds.indexOf(question.id);
  const questionTypeLabel = question.type === "multi" ? "多选题" : "单选题";

  elements.questionPanel.classList.remove("is-hidden");
  if (appState.currentMode !== "review") {
    elements.reviewPanel.classList.add("is-hidden");
  }
  hideEmptyState();

  elements.modeTitle.textContent = `${modeLabels[appState.currentMode]} · ${questionTypeLabel}`;
  elements.questionCounter.textContent = `连续编号 ${question.id}${modeIndex >= 0 ? ` · 当前题集第 ${modeIndex + 1} / ${modeIds.length} 题` : ""}`;
  elements.questionTitle.textContent = `第 ${question.id} 题：${question.stem}`;
  elements.questionSourceMeta.textContent = `原题号 ${question.sourceNos?.join("、") ?? question.sourceNo} · 选项 ${question.options.length} 个${question.duplicateCount > 1 ? ` · 本题内容重复出现 ${question.duplicateCount} 次` : ""}`;
  elements.markUncertainCheckbox.checked = state.inUncertainBook;

  elements.questionOptions.innerHTML = question.options
    .map(
      (option) => `
        <label class="option-card">
          <input type="checkbox" name="question-option" value="${option.key}">
          <span class="option-content">
            <span class="option-key">${option.key}</span>
            <span class="option-text">${option.text}</span>
          </span>
        </label>
      `,
    )
    .join("");

  elements.resultPanel.classList.add("is-hidden");
  elements.resultPanel.innerHTML = "";
  hideNoteEditor();
  elements.submitAnswerButton.classList.remove("is-hidden");
  elements.submitAnswerButton.disabled = false;
  elements.nextQuestionButton.classList.add("is-hidden");
  elements.copyQuestionButton.classList.remove("is-hidden");
  elements.showAnswerButton.classList.toggle("is-hidden", appState.currentMode !== "review");
  elements.markUncertainCheckbox.disabled = false;

  const optionInputs = [...elements.questionForm.querySelectorAll('input[name="question-option"]')];
  for (const input of optionInputs) {
    if (state.lastSelected.includes(input.value) && appState.currentMode === "review") {
      input.checked = true;
    } else {
      input.checked = false;
    }
    input.disabled = false;
  }
}

function renderQuestionResult(result) {
  const tone = result.isCorrect ? "success" : "danger";
  const tags = [];

  if (result.markedUncertain) {
    tags.push("已标注为不确定");
  }
  if (result.addedToWrongBook) {
    tags.push("已加入做错了题库");
  }
  if (result.removedFromWrongBook) {
    tags.push("已从做错了题库移除");
  }
  if (result.addedToUncertainBook) {
    tags.push("已加入不确定题库");
  }
  if (result.removedFromUncertainBook) {
    tags.push("已从不确定题库移除");
  }

  elements.resultPanel.classList.remove("is-hidden");
  elements.resultPanel.innerHTML = `
    <div class="banner banner-${tone}">
      <div><strong>${result.isCorrect ? "回答正确" : "回答错误"}</strong></div>
      <div>你的答案：${result.selected.length ? formatAnswer(result.selected) : "未选择"}</div>
      <div>正确答案：${formatAnswer(result.answer)}</div>
      <div>${tags.length ? tags.join("；") : "状态已记录。"}</div>
    </div>
  `;

  appState.currentQuestionSubmitted = true;
  elements.submitAnswerButton.disabled = true;
  elements.nextQuestionButton.classList.remove("is-hidden");
  [...elements.questionForm.querySelectorAll('input[name="question-option"]')].forEach((input) => {
    input.disabled = true;
  });

  const note = getQuestionNote(result.questionId);
  showNoteEditor({
    note,
    statusText: note ? "已保存当前备注" : "可选：给这一题补充备注",
  });
}

function renderReview(question) {
  const state = getStateForQuestion(question.id);
  appState.reviewQuestionId = question.id;

  renderQuestion(question);
  elements.reviewPanel.classList.remove("is-hidden");
  elements.questionPanel.classList.remove("is-hidden");
  hideEmptyState();
  elements.modeTitle.textContent = `${modeLabels.review} · ${question.type === "multi" ? "多选题" : "单选题"}`;
  elements.questionCounter.textContent = `连续编号 ${question.id}`;
  elements.submitAnswerButton.classList.add("is-hidden");
  elements.nextQuestionButton.classList.add("is-hidden");
  elements.markUncertainCheckbox.disabled = true;
  [...elements.questionForm.querySelectorAll('input[name="question-option"]')].forEach((input) => {
    input.disabled = true;
  });

  elements.reviewTitle.textContent = `复盘：第 ${question.id} 题`;
  elements.reviewSubtitle.textContent = `原题号 ${question.sourceNos?.join("、") ?? question.sourceNo} · 最近一次作答 ${formatDateTime(state.lastSubmittedAt)}${question.duplicateCount > 1 ? ` · 本题内容重复出现 ${question.duplicateCount} 次` : ""}`;

  const tags = [
    state.everWrong ? `<span class="tag tag-danger">曾经做错</span>` : "",
    state.everUncertain ? `<span class="tag tag-warning">曾经不会</span>` : "",
    state.inWrongBook ? `<span class="tag tag-danger">当前在做错了题库</span>` : "",
    state.inUncertainBook ? `<span class="tag tag-warning">当前在不确定题库</span>` : "",
    state.lastCorrect === true ? `<span class="tag tag-success">最近一次答对</span>` : "",
    state.lastCorrect === false ? `<span class="tag tag-danger">最近一次答错</span>` : "",
  ].filter(Boolean);

  elements.reviewTags.innerHTML = tags.join("") || `<span class="tag">暂无标签</span>`;

  if (appState.reviewAnswerVisible) {
    elements.reviewAnswerBlock.innerHTML = `
      <strong>正确答案：</strong>${formatAnswer(question.answer)}<br>
      <strong>你的最近选择：</strong>${state.lastSelected.length ? formatAnswer(state.lastSelected) : "暂无"}<br>
      <strong>累计作答：</strong>${state.attemptCount} 次，累计做错 ${state.wrongCount} 次
    `;
    elements.showAnswerButton.textContent = "隐藏答案";
  } else {
    elements.reviewAnswerBlock.innerHTML = `
      <strong>答案已隐藏。</strong><br>
      点击上方“查看答案”按钮后再显示正确答案和最近作答记录。
    `;
    elements.showAnswerButton.textContent = "查看答案";
  }

  elements.showAnswerButton.classList.remove("is-hidden");

  showNoteEditor({
    note: normalizeNote(state.note),
    statusText: state.note?.trim() ? "已保存当前备注" : "可选：给这一题补充备注",
  });

  void renderAttempts(question.id);
}

async function renderStatsPanel() {
  elements.statsPanel.classList.remove("is-hidden");
  elements.questionPanel.classList.add("is-hidden");
  elements.reviewPanel.classList.add("is-hidden");
  hideEmptyState();

  const attempts = await getAllAttempts(appState.database);
  const wrongHistory = appState.questions.filter((question) => getStateForQuestion(question.id).everWrong);
  const uncertainHistory = appState.questions.filter((question) => getStateForQuestion(question.id).everUncertain);
  const wrongResolved = wrongHistory.filter((question) => !getStateForQuestion(question.id).inWrongBook);
  const uncertainResolved = uncertainHistory.filter((question) => !getStateForQuestion(question.id).inUncertainBook);

  const wrongPracticeAttempts = attempts.filter((attempt) => attempt.mode === "wrong");
  const uncertainPracticeAttempts = attempts.filter((attempt) => attempt.mode === "uncertain");
  const wrongPracticeCorrect = wrongPracticeAttempts.filter((attempt) => attempt.isCorrect);
  const uncertainPracticeCorrect = uncertainPracticeAttempts.filter((attempt) => attempt.isCorrect);

  const cards = [
    { label: "曾进入错题库", value: `${wrongHistory.length}`, note: `当前仍在错题库 ${wrongHistory.length - wrongResolved.length} 题` },
    { label: "错题已重练移出", value: `${wrongResolved.length}`, note: `错题模式作答 ${wrongPracticeAttempts.length} 次` },
    { label: "曾进入不确定题库", value: `${uncertainHistory.length}`, note: `当前仍在不确定题库 ${uncertainHistory.length - uncertainResolved.length} 题` },
    { label: "不确定题已重练移出", value: `${uncertainResolved.length}`, note: `不确定模式作答 ${uncertainPracticeAttempts.length} 次` },
  ];

  elements.statsSubtitle.textContent = `错题重练答对 ${wrongPracticeCorrect.length} 次，不确定题重练答对 ${uncertainPracticeCorrect.length} 次。`;
  elements.statsCards.innerHTML = cards
    .map(
      (card) => `
        <article class="summary-card">
          <span>${card.label}</span>
          <strong>${card.value}</strong>
          <div class="summary-note">${card.note}</div>
        </article>
      `,
    )
    .join("");

  const detailSections = [
    {
      title: "仍在错题库的题目",
      questions: wrongHistory.filter((question) => getStateForQuestion(question.id).inWrongBook),
    },
    {
      title: "已从错题库移出的题目",
      questions: wrongResolved,
    },
    {
      title: "仍在不确定题库的题目",
      questions: uncertainHistory.filter((question) => getStateForQuestion(question.id).inUncertainBook),
    },
    {
      title: "已从不确定题库移出的题目",
      questions: uncertainResolved,
    },
  ];

  elements.statsDetails.innerHTML = detailSections
    .map((section) => {
      const items = section.questions.length
        ? section.questions
            .slice(0, 20)
            .map(
              (question) => `
                <button type="button" class="filter-item" data-question-id="${question.id}">
                  <strong>#${question.id} ${question.stem}</strong>
                  <div class="filter-item-meta">原题号 ${question.sourceNos?.join("、") ?? question.sourceNo} · 点击跳转复盘</div>
                </button>
              `,
            )
            .join("")
        : `<div class="attempt-card">暂无题目。</div>`;

      return `
        <section class="attempt-card">
          <h3>${section.title}</h3>
          <div class="attempt-list">${items}</div>
        </section>
      `;
    })
    .join("");
}

async function renderAttempts(questionId) {
  const attempts = await getAttemptsByQuestionId(appState.database, questionId);
  if (!attempts.length) {
    elements.reviewAttempts.innerHTML = `<div class="attempt-card"><h3>暂无作答记录</h3></div>`;
    return;
  }

  elements.reviewAttempts.innerHTML = attempts
    .map(
      (attempt, index) => `
        <article class="attempt-card">
          <h3>第 ${attempts.length - index} 次记录</h3>
          <div class="attempt-meta">模式：${modeLabels[attempt.mode]} · 时间：${formatDateTime(attempt.submittedAt)}</div>
          <div>你的答案：${attempt.selected.length ? formatAnswer(attempt.selected) : "未选择"}</div>
          <div>正确答案：${formatAnswer(attempt.answer)}</div>
          <div>结果：${attempt.isCorrect ? "正确" : "错误"}${attempt.markedUncertain ? " · 标注为不确定" : ""}</div>
        </article>
      `,
    )
    .join("");
}

async function switchMode(mode) {
  appState.currentMode = mode;
  appState.pendingResult = null;
  setModeButtons();

  if (mode === "stats") {
    await renderStatsPanel();
    await persistViewState();
    setBanner("已切换到重练统计页。", "info");
    return;
  }

  if (mode === "review") {
    if (!appState.reviewQuestionId) {
      appState.reviewQuestionId = appState.questions[0]?.id ?? null;
    }

    const question = getQuestionByIdLocal(appState.reviewQuestionId);
    if (question) {
      renderReview(question);
      setBanner("复盘模式下可查看历史记录，也可以手动删除“曾经做错/曾经不会”标签。", "info");
    } else {
      showEmptyState("当前没有可复盘的题目。");
    }

    await persistViewState();
    return;
  }

  const ids = getQuestionIdsForMode(mode);
  appState.currentQuestionId = ids.includes(appState.currentQuestionId) ? appState.currentQuestionId : ids[0] ?? null;

  if (!appState.currentQuestionId) {
    const emptyText =
      mode === "main" ? "主题库已经全部做完了。" :
      mode === "wrong" ? "做错了题库目前是空的。" :
      "不确定题库目前是空的。";
    showEmptyState(emptyText);
    setBanner("当前模式没有待做题目。", "success");
    await persistViewState();
    return;
  }

  renderQuestion(getQuestionByIdLocal(appState.currentQuestionId));
  setBanner(`已切换到${modeLabels[mode]}。`, "info");
  await persistViewState();
}

function getNextQuestionIdAfter(questionId, mode) {
  const ids = getQuestionIdsForMode(mode);
  const index = ids.indexOf(questionId);
  if (index === -1) return ids[0] ?? null;
  return ids[index + 1] ?? ids[index] ?? null;
}

async function handleSubmit(event) {
  event.preventDefault();
  if (!appState.currentQuestion) return;

  const selected = getSelectedAnswers();
  if (!selected.length) {
    setBanner("每道题至少要选择一个选项后才能提交。", "warning");
    return;
  }

  const question = appState.currentQuestion;
  const previousModeIds =
    appState.currentMode === "wrong" || appState.currentMode === "uncertain"
      ? getQuestionIdsForMode(appState.currentMode)
      : null;
  const previousState = getStateForQuestion(question.id);
  const markedUncertain = elements.markUncertainCheckbox.checked;
  const submittedAt = new Date().toISOString();
  const submission = evaluateSubmission({
    previousState,
    question,
    selected,
    mode: appState.currentMode,
    markedUncertain,
    submittedAt,
  });
  const updatedState = submission.nextState;

  await putState(appState.database, updatedState);
  saveStateLocally(updatedState);

  await addAttempt(appState.database, submission.attempt);

  appState.pendingResult = submission.result;
  appState.pendingResult.questionId = question.id;

  renderQuestionResult(appState.pendingResult);
  renderSummary();

  if (appState.currentMode === "main") {
    appState.currentQuestionId = getNextQuestionIdAfter(question.id, "main");
  } else if (appState.currentMode === "wrong" || appState.currentMode === "uncertain") {
    const nextId = getNextQuestionIdFromPreviousOrder(question.id, previousModeIds ?? []);
    const currentSet = getQuestionIdsForMode(appState.currentMode);
    appState.currentQuestionId = currentSet.includes(nextId) ? nextId : currentSet[0] ?? null;
  }

  await persistViewState();

  setBanner("本题结果已经保存，下次打开网页会继续保留。", submission.result.isCorrect ? "success" : "warning");
}

async function handleToggleUncertainAfterSubmit() {
  if (!appState.currentQuestion || appState.currentMode === "review") return;

  const question = appState.currentQuestion;
  const previousState = getStateForQuestion(question.id);
  const checked = elements.markUncertainCheckbox.checked;
  const nextState = { ...previousState };
  const canBeUncertain = !nextState.inWrongBook;
  const orderTouchedAt = new Date().toISOString();

  if (checked) {
    nextState.inUncertainBook = canBeUncertain;
    nextState.everUncertain = true;
    nextState.uncertainBookOrderAt = canBeUncertain ? orderTouchedAt : null;
  } else {
    nextState.inUncertainBook = false;
    nextState.uncertainBookOrderAt = null;
  }

  if (nextState.inWrongBook) {
    nextState.uncertainBookOrderAt = null;
  }

  await putState(appState.database, nextState);
  saveStateLocally(nextState);

  if (appState.pendingResult) {
    appState.pendingResult.markedUncertain = checked && canBeUncertain;
    appState.pendingResult.addedToUncertainBook = checked && canBeUncertain && !previousState.inUncertainBook;
    appState.pendingResult.removedFromUncertainBook =
      (!checked && previousState.inUncertainBook) || (checked && !canBeUncertain && previousState.inUncertainBook);
    renderQuestionResult(appState.pendingResult);
  }

  renderSummary();
  await persistViewState();
  setBanner(canBeUncertain || !checked ? "“标注不确定”状态已更新。" : "当前这道题仍在错题库中，因此不会进入不确定题库。", canBeUncertain || !checked ? "success" : "warning");
}

async function handleNextQuestion() {
  if (appState.currentMode === "review") return;

  const nextQuestion = getQuestionByIdLocal(appState.currentQuestionId);
  if (!nextQuestion) {
    const modeText =
      appState.currentMode === "main" ? "主题库已经全部完成。" :
      appState.currentMode === "wrong" ? "做错了题库已经清空。" :
      "不确定题库已经清空。";
    showEmptyState(modeText);
    renderSummary();
    setBanner(modeText, "success");
    await persistViewState();
    return;
  }

  renderQuestion(nextQuestion);
  renderSummary();
  await persistViewState();
}

async function handleReviewJump(event) {
  event.preventDefault();
  const requested = Number(elements.reviewQuestionId.value);
  if (!Number.isInteger(requested) || requested < 1) {
    setBanner("请输入有效的连续编号。", "warning");
    return;
  }

  const question = getQuestionByIdLocal(requested);
  if (!question) {
    setBanner(`没有找到连续编号为 ${requested} 的题目。`, "warning");
    return;
  }

  appState.currentMode = "review";
  appState.reviewQuestionId = requested;
  appState.reviewAnswerVisible = false;
  setModeButtons();
  renderReview(question);
  await persistViewState();
  setBanner(`已跳转到第 ${requested} 题的复盘页面。`, "info");
}

async function handleQuickReviewJump(questionId) {
  const question = getQuestionByIdLocal(questionId);
  if (!question) {
    setBanner(`没有找到连续编号为 ${questionId} 的题目。`, "warning");
    return;
  }

  appState.currentMode = "review";
  appState.reviewQuestionId = questionId;
  appState.reviewAnswerVisible = false;
  setModeButtons();
  renderReview(question);
  await persistViewState();
  setBanner(`已跳转到第 ${questionId} 题的复盘页面。`, "info");
}

async function handleFilterJump(questionId) {
  const question = getQuestionByIdLocal(questionId);
  if (!question) {
    setBanner(`没有找到连续编号为 ${questionId} 的题目。`, "warning");
    return;
  }

  appState.currentMode = "review";
  appState.reviewQuestionId = questionId;
  appState.reviewAnswerVisible = false;
  setModeButtons();
  renderReview(question);
  await persistViewState();
  setBanner(`已从筛选列表跳转到第 ${questionId} 题。`, "info");
}

async function exportProgress() {
  if (!appState.questions.length) {
    setBanner("当前还没有题库，暂无可导出的进度。", "warning");
    return;
  }

  const states = await getAllStates(appState.database);
  const attempts = await getAllAttempts(appState.database);
  const viewState = await getMeta(appState.database, "viewState");
  const rawQuestions = await getMeta(appState.database, RAW_QUESTIONS_META_KEY);

  const snapshot = {
    kind: "marx-question-bank-progress",
    version: 1,
    exportedAt: new Date().toISOString(),
    sourceInfo: appState.sourceInfo,
    rawQuestions,
    states,
    attempts,
    viewState,
  };

  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `marx-progress-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  elements.backupStatus.textContent = `已导出进度，共 ${states.length} 条题目状态、${attempts.length} 条作答记录。`;
  setBanner("进度导出完成。", "success");
}

async function importProgress(event) {
  try {
    const [file] = event.target.files ?? [];
    if (!file) return;
    const text = await file.text();
    const snapshot = JSON.parse(text);

    if (snapshot.kind !== "marx-question-bank-progress" || snapshot.version !== 1) {
      throw new Error("这不是当前版本支持的进度备份文件。");
    }

    if (!appState.sourceInfo?.hash) {
      throw new Error("请先导入题库，再导入进度。");
    }

    if (snapshot.sourceInfo?.hash !== appState.sourceInfo.hash) {
      throw new Error("备份文件对应的题库与当前题库不一致，已阻止导入。");
    }

    const validQuestionIds = new Set(appState.questions.map((question) => question.id));
    const statesValid = Array.isArray(snapshot.states)
      && snapshot.states.every((state) => validQuestionIds.has(state.questionId));
    const attemptsValid = Array.isArray(snapshot.attempts)
      && snapshot.attempts.every((attempt) => validQuestionIds.has(attempt.questionId));
    const structureCompatible =
      snapshot.sourceInfo?.structureVersion === QUESTION_BANK_STRUCTURE_VERSION
      && snapshot.sourceInfo?.questionCount === appState.questions.length;
    const currentRawQuestions = await getMeta(appState.database, RAW_QUESTIONS_META_KEY);
    const rawQuestionsForMigration = Array.isArray(snapshot.rawQuestions) && snapshot.rawQuestions.length
      ? snapshot.rawQuestions
      : currentRawQuestions;

    if (statesValid && attemptsValid && structureCompatible) {
      await restoreProgressSnapshot(appState.database, snapshot);
    } else {
      const currentSourceInfo = {
        ...(appState.sourceInfo ?? {}),
        structureVersion: QUESTION_BANK_STRUCTURE_VERSION,
        questionCount: appState.questions.length,
      };
      const migrated = migrateQuestionBankData({
        oldQuestions: Array.isArray(rawQuestionsForMigration) && rawQuestionsForMigration.length
          ? rawQuestionsForMigration
          : appState.questions,
        oldStates: snapshot.states ?? [],
        oldAttempts: snapshot.attempts ?? [],
        oldViewState: snapshot.viewState,
        newQuestions: appState.questions,
      });

      await replaceQuestionBank(appState.database, {
        questions: appState.questions,
        states: migrated.states,
        attempts: migrated.attempts,
        sourceInfo: currentSourceInfo,
        viewState: migrated.viewState,
      });
    }

    if (Array.isArray(rawQuestionsForMigration) && rawQuestionsForMigration.length) {
      await setMeta(appState.database, RAW_QUESTIONS_META_KEY, rawQuestionsForMigration);
    }

    await reloadFromDatabase();
    elements.backupStatus.textContent = `已导入进度：${file.name} · 导出时间 ${formatDateTime(snapshot.exportedAt)}`;
    setBanner("进度导入完成。", "success");
    event.target.value = "";
  } catch (error) {
    console.error(error);
    event.target.value = "";
    setBanner(`导入进度失败：${error.message}`, "danger");
  }
}

async function handleToggleReviewAnswer() {
  if (appState.currentMode !== "review" || !appState.reviewQuestionId) return;
  appState.reviewAnswerVisible = !appState.reviewAnswerVisible;
  const question = getQuestionByIdLocal(appState.reviewQuestionId);
  if (question) {
    renderReview(question);
    await persistViewState();
  }
}

async function handleRemoveTag(kind) {
  const questionId = appState.reviewQuestionId;
  if (!questionId) return;

  const state = applyManualTagRemoval(getStateForQuestion(questionId), kind);

  await putState(appState.database, state);
  saveStateLocally(state);
  renderSummary();

  const question = getQuestionByIdLocal(questionId);
  if (question) {
    renderReview(question);
  }

  await persistViewState();
  setBanner("标签已更新。", "success");
}

async function handleSaveNote() {
  const questionId =
    appState.currentMode === "review"
      ? appState.reviewQuestionId
      : appState.currentQuestionSubmitted
        ? appState.currentQuestion?.id ?? null
        : null;

  if (!questionId) {
    setBanner("请先完成当前题目，或在复盘中打开一道历史题目后再提交备注。", "warning");
    return;
  }

  const previousState = getStateForQuestion(questionId);
  const normalizedNote = normalizeNote(elements.noteInput.value);
  const nextState = {
    ...previousState,
    note: normalizedNote,
  };

  await putState(appState.database, nextState);
  saveStateLocally(nextState);
  showNoteEditor({
    note: normalizedNote,
    statusText: normalizedNote ? "备注已保存" : "备注已清空",
  });

  if (appState.currentMode === "review") {
    const question = getQuestionByIdLocal(questionId);
    if (question) {
      renderReview(question);
    }
  } else if (appState.pendingResult?.questionId === questionId) {
    renderQuestionResult(appState.pendingResult);
  }

  setBanner(normalizedNote ? "题目备注已保存。" : "题目备注已清空。", "success");
}

async function importQuestionBankFromText(rawText, sourceName) {
  const normalizedText = rawText.replace(/\r\n/gu, "\n");
  const { rawQuestions, questions } = prepareQuestionBank(normalizedText);

  if (!questions.length) {
    throw new Error("没有从题库中解析到有效题目，请检查 base.txt 的内容格式。");
  }

  const mergedDuplicateCount = rawQuestions.length - questions.length;
  const sourceInfo = {
    name: sourceName,
    hash: hashText(normalizedText),
    importedAt: new Date().toISOString(),
    questionCount: questions.length,
    rawQuestionCount: rawQuestions.length,
    mergedDuplicateCount,
    structureVersion: QUESTION_BANK_STRUCTURE_VERSION,
  };

  const oldQuestions = await getAllQuestions(appState.database);
  const oldStates = await getAllStates(appState.database);
  const oldAttempts = await getAllAttempts(appState.database);
  const oldViewState = await getMeta(appState.database, "viewState");

  if (!oldQuestions.length && !oldStates.length && !oldAttempts.length) {
    await seedDatabase(appState.database, questions, sourceInfo);
  } else {
    const migrated = migrateQuestionBankData({
      oldQuestions,
      oldStates,
      oldAttempts,
      oldViewState,
      newQuestions: questions,
    });

    await replaceQuestionBank(appState.database, {
      questions,
      states: migrated.states,
      attempts: migrated.attempts,
      sourceInfo,
      viewState: migrated.viewState,
    });
  }

  await setMeta(appState.database, RAW_QUESTIONS_META_KEY, rawQuestions);
  appState.sourceInfo = sourceInfo;
  await reloadFromDatabase();

  setBanner(
    mergedDuplicateCount > 0
      ? `题库导入完成，已去重为 ${questions.length} 道题，并合并了 ${mergedDuplicateCount} 次重复出现。`
      : `题库导入完成，共解析 ${questions.length} 道题。`,
    "success",
  );
  elements.sourceStatus.textContent = mergedDuplicateCount > 0
    ? `当前题库：${sourceInfo.name} · 去重后 ${sourceInfo.questionCount} 题 · 原始解析 ${sourceInfo.rawQuestionCount} 题`
    : `当前题库：${sourceInfo.name} · 共 ${sourceInfo.questionCount} 题`;
}

async function tryAutoImportBaseTxt() {
  try {
    const response = await fetch("./base.txt", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`读取失败：${response.status}`);
    }

    const text = await response.text();
    const incomingHash = hashText(text.replace(/\r\n/gu, "\n"));

    if (!appState.questions.length) {
      await importQuestionBankFromText(text, "base.txt");
      return;
    }

    if (appState.sourceInfo?.hash && appState.sourceInfo.hash !== incomingHash) {
      elements.sourceStatus.textContent = "检测到 base.txt 内容与当前已导入题库不同。如需切换到新题库，请点击“重建题库”后重新导入。";
      setBanner("检测到题库源文件发生变化。为避免误清空进度，当前未自动覆盖已有题库。", "warning");
      return;
    }

    const { questions: preparedQuestions } = prepareQuestionBank(text.replace(/\r\n/gu, "\n"));
    const needsStructureMigration =
      (appState.sourceInfo?.structureVersion ?? 1) !== QUESTION_BANK_STRUCTURE_VERSION
      || appState.questions.length !== preparedQuestions.length;

    if (needsStructureMigration) {
      await importQuestionBankFromText(text, appState.sourceInfo?.name ?? "base.txt");
      setBanner("已自动修复题库结构并迁移原有进度。", "success");
      return;
    }

    elements.sourceStatus.textContent = `当前题库：${appState.sourceInfo?.name ?? "base.txt"} · 共 ${appState.questions.length} 题`;
  } catch (error) {
    if (!appState.questions.length) {
      setBanner("自动读取 base.txt 失败，请使用左侧的文件选择器手动导入。", "warning");
      showEmptyState("还没有题库数据。请手动导入同目录下的 base.txt。");
    }
    elements.sourceStatus.textContent = "自动读取 base.txt 失败，通常是因为你直接用文件方式打开了网页。手动导入即可继续。";
  }
}

async function reloadFromDatabase() {
  appState.questions = await getAllQuestions(appState.database);
  const states = await getAllStates(appState.database);
  appState.stateMap = new Map(states.map((state) => [state.questionId, state]));
  appState.sourceInfo = await getMeta(appState.database, "sourceInfo");

  renderSummary();
  await loadViewState();
  setModeButtons();

  if (!appState.questions.length) {
    showEmptyState("当前数据库里还没有题库。请等待自动导入，或手动导入 base.txt。");
    return;
  }

  if (appState.currentMode === "stats") {
    await renderStatsPanel();
    return;
  }

  if (appState.currentMode === "review") {
    const question = getQuestionByIdLocal(appState.reviewQuestionId ?? appState.questions[0].id);
    if (question) {
      renderReview(question);
      return;
    }
  }

  const targetQuestion = getQuestionByIdLocal(appState.currentQuestionId ?? getDefaultQuestionIdForMode(appState.currentMode));
  if (targetQuestion) {
    renderQuestion(targetQuestion);
  } else {
    const message =
      appState.currentMode === "main" ? "主题库已经全部完成。" :
      appState.currentMode === "wrong" ? "做错了题库目前为空。" :
      appState.currentMode === "uncertain" ? "不确定题库目前为空。" :
      "没有可复盘的题目。";
    showEmptyState(message);
  }
}

async function handleFileImport(event) {
  try {
    const [file] = event.target.files ?? [];
    if (!file) return;
    const text = await file.text();
    await importQuestionBankFromText(text, file.name);
    event.target.value = "";
  } catch (error) {
    console.error(error);
    setBanner(`手动导入失败：${error.message}`, "danger");
  }
}

async function handleRebuildBank() {
  try {
    openConfirmModal({
      title: "重建题库",
      message: "这会清空当前题库、进度、错题和不确定记录，然后重新开始。",
      tone: "danger",
      onConfirm: async () => {
        await clearEntireDatabase(appState.database);
        appState.questions = [];
        appState.stateMap = new Map();
        appState.currentQuestionId = null;
        appState.currentQuestion = null;
        appState.reviewQuestionId = null;
        appState.currentQuestionSubmitted = false;
        appState.sourceInfo = null;
        appState.currentMode = "main";
        renderSummary();
        showEmptyState("题库已清空，正在尝试重新读取 base.txt；如果失败，请手动导入。");
        setBanner("题库已清空，正在重新初始化。", "warning");
        await tryAutoImportBaseTxt();
      },
    });
  } catch (error) {
    console.error(error);
    setBanner(`重建题库失败：${error.message}`, "danger");
  }
}

async function handleResetProgress() {
  try {
    if (!appState.questions.length) {
      setBanner("当前还没有题库，暂无可清空的进度。", "warning");
      return;
    }

    openConfirmModal({
      title: "清空所有进度",
      message: "这会清空所有做题进度、错题和不确定记录，但保留当前题库。",
      tone: "danger",
      onConfirm: async () => {
        const rawQuestions = await getMeta(appState.database, RAW_QUESTIONS_META_KEY);
        await clearAllProgress(appState.database);
        if (Array.isArray(rawQuestions) && rawQuestions.length) {
          await setMeta(appState.database, RAW_QUESTIONS_META_KEY, rawQuestions);
        }
        appState.currentMode = "main";
        appState.currentQuestionId = null;
        appState.currentQuestion = null;
        appState.reviewQuestionId = null;
        appState.currentQuestionSubmitted = false;
        appState.reviewAnswerVisible = false;
        await reloadFromDatabase();
        setBanner("所有做题进度已清空，题库保留。", "success");
      },
    });
  } catch (error) {
    console.error(error);
    setBanner(`清空进度失败：${error.message}`, "danger");
  }
}

async function handleRestartMain() {
  try {
    if (!appState.questions.length) {
      setBanner("当前还没有题库，暂无可重做的内容。", "warning");
      return;
    }

    openConfirmModal({
      title: "从头重做",
      message: "这会把主题库的作答进度重置为从第一题重新开始，但不会清空错题库、不确定题库和历史标签。",
      tone: "primary",
      onConfirm: async () => {
        await restartMainProgress(appState.database);
        appState.currentMode = "main";
        appState.currentQuestionId = 1;
        appState.currentQuestion = null;
        appState.reviewQuestionId = 1;
        appState.currentQuestionSubmitted = false;
        appState.reviewAnswerVisible = false;
        await reloadFromDatabase();
        setBanner("已重置主题库进度，现在会从第一题重新开始。", "success");
      },
    });
  } catch (error) {
    console.error(error);
    setBanner(`从头重做失败：${error.message}`, "danger");
  }
}

function bindEvents() {
  elements.questionForm.addEventListener("submit", handleSubmit);
  elements.nextQuestionButton.addEventListener("click", () => {
    void handleNextQuestion();
  });
  elements.showAnswerButton.addEventListener("click", () => {
    void handleToggleReviewAnswer();
  });
  elements.copyQuestionButton.addEventListener("click", () => {
    void handleCopyQuestion();
  });
  elements.markUncertainCheckbox.addEventListener("change", () => {
    if (!appState.currentQuestionSubmitted) return;
    void handleToggleUncertainAfterSubmit();
  });
  elements.saveNoteButton.addEventListener("click", () => {
    void handleSaveNote();
  });
  elements.reviewForm.addEventListener("submit", (event) => {
    void handleReviewJump(event);
  });
  elements.searchInput.addEventListener("input", (event) => {
    appState.searchKeyword = event.target.value;
    renderFilterList();
  });
  elements.filterToolbar.addEventListener("click", (event) => {
    const target = event.target.closest("[data-filter]");
    if (!target) return;
    appState.currentFilter = target.dataset.filter;
    renderFilterList();
  });
  elements.filterList.addEventListener("click", (event) => {
    const target = event.target.closest("[data-question-id]");
    if (!target) return;
    const questionId = Number(target.dataset.questionId);
    if (!Number.isInteger(questionId)) return;
    void handleFilterJump(questionId);
  });
  elements.duplicateList.addEventListener("click", (event) => {
    const target = event.target.closest("[data-question-id]");
    if (!target) return;
    const questionId = Number(target.dataset.questionId);
    if (!Number.isInteger(questionId)) return;
    void handleQuickReviewJump(questionId);
  });
  elements.reviewQuickList.addEventListener("click", (event) => {
    const target = event.target.closest("[data-review-id]");
    if (!target) return;
    const questionId = Number(target.dataset.reviewId);
    if (!Number.isInteger(questionId)) return;
    void handleQuickReviewJump(questionId);
  });
  elements.statsDetails.addEventListener("click", (event) => {
    const target = event.target.closest("[data-question-id]");
    if (!target) return;
    const questionId = Number(target.dataset.questionId);
    if (!Number.isInteger(questionId)) return;
    void handleQuickReviewJump(questionId);
  });
  elements.importFileInput.addEventListener("change", (event) => {
    void handleFileImport(event);
  });
  elements.importProgressInput.addEventListener("change", (event) => {
    void importProgress(event);
  });
  elements.exportProgressButton.addEventListener("click", () => {
    void exportProgress();
  });
  elements.exportWrongMdButton.addEventListener("click", () => {
    exportMarkdown("wrong");
  });
  elements.exportWrongPdfButton.addEventListener("click", () => {
    exportPdf("wrong");
  });
  elements.exportUncertainMdButton.addEventListener("click", () => {
    exportMarkdown("uncertain");
  });
  elements.exportUncertainPdfButton.addEventListener("click", () => {
    exportPdf("uncertain");
  });
  elements.removeEverWrongButton.addEventListener("click", () => {
    void handleRemoveTag("everWrong");
  });
  elements.removeEverUncertainButton.addEventListener("click", () => {
    void handleRemoveTag("everUncertain");
  });
  elements.rebuildBankButton.addEventListener("click", () => {
    void handleRebuildBank();
  });
  elements.restartMainButton.addEventListener("click", () => {
    void handleRestartMain();
  });
  elements.resetProgressButton.addEventListener("click", () => {
    void handleResetProgress();
  });
  elements.confirmModalCancel.addEventListener("click", closeConfirmModal);
  elements.confirmModal.addEventListener("click", (event) => {
    if (event.target === elements.confirmModal) {
      closeConfirmModal();
    }
  });
  elements.confirmModalConfirm.addEventListener("click", async () => {
    const action = appState.activeConfirmAction;
    closeConfirmModal();
    if (!action) return;
    try {
      await action();
    } catch (error) {
      console.error(error);
      setBanner(`操作失败：${error.message}`, "danger");
    }
  });

  for (const button of elements.modeButtons) {
    button.addEventListener("click", () => {
      void switchMode(button.dataset.mode);
    });
  }
}

async function bootstrap() {
  bindEvents();
  appState.database = await openDatabase();
  await reloadFromDatabase();
  await tryAutoImportBaseTxt();

  if (appState.sourceInfo) {
    elements.sourceStatus.textContent = `当前题库：${appState.sourceInfo.name} · 共 ${appState.sourceInfo.questionCount} 题`;
  }
}

bootstrap().catch((error) => {
  console.error(error);
  setBanner(`初始化失败：${error.message}`, "danger");
  showEmptyState("初始化失败。请打开浏览器控制台查看错误信息。");
});
