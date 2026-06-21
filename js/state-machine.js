import { createDefaultState } from "./db.js";

export function areAnswersEqual(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function buildAttemptRecord({
  questionId,
  mode,
  selected,
  answer,
  markedUncertain,
  submittedAt,
}) {
  return {
    questionId,
    mode,
    selected: [...selected].sort(),
    answer: [...answer].sort(),
    isCorrect: areAnswersEqual([...selected].sort(), [...answer].sort()),
    markedUncertain: Boolean(markedUncertain),
    submittedAt,
  };
}

export function evaluateSubmission({
  previousState,
  question,
  selected,
  mode,
  markedUncertain,
  submittedAt = new Date().toISOString(),
}) {
  const baseState = previousState ? { ...previousState } : createDefaultState(question.id);
  const normalizedSelected = [...selected].sort();
  const normalizedAnswer = [...question.answer].sort();
  const isCorrect = areAnswersEqual(normalizedSelected, normalizedAnswer);

  const nextState = {
    ...baseState,
    mainDone: mode === "main" ? true : baseState.mainDone,
    lastSelected: normalizedSelected,
    lastCorrect: isCorrect,
    lastMode: mode,
    lastSubmittedAt: submittedAt,
    attemptCount: baseState.attemptCount + 1,
  };

  let addedToWrongBook = false;
  let removedFromWrongBook = false;
  let addedToUncertainBook = false;
  let removedFromUncertainBook = false;

  if (markedUncertain) {
    nextState.everUncertain = true;
    if (!baseState.inUncertainBook) {
      addedToUncertainBook = true;
    }
    nextState.inUncertainBook = true;
  }

  if (isCorrect) {
    if (baseState.inWrongBook) {
      nextState.inWrongBook = false;
      removedFromWrongBook = true;
    }

    if (baseState.inUncertainBook) {
      nextState.inUncertainBook = false;
      removedFromUncertainBook = true;
      addedToUncertainBook = false;
    }
  } else {
    nextState.everWrong = true;
    nextState.wrongCount = baseState.wrongCount + 1;

    if (!baseState.inWrongBook) {
      addedToWrongBook = true;
    }
    nextState.inWrongBook = true;

    if (nextState.inUncertainBook) {
      nextState.inUncertainBook = false;
      addedToUncertainBook = false;
      removedFromUncertainBook = baseState.inUncertainBook || Boolean(markedUncertain);
    }
  }

  return {
    nextState,
    attempt: buildAttemptRecord({
      questionId: question.id,
      mode,
      selected: normalizedSelected,
      answer: normalizedAnswer,
      markedUncertain,
      submittedAt,
    }),
    result: {
      answer: normalizedAnswer,
      selected: normalizedSelected,
      isCorrect,
      markedUncertain: Boolean(markedUncertain),
      addedToWrongBook,
      removedFromWrongBook,
      addedToUncertainBook,
      removedFromUncertainBook,
    },
  };
}
