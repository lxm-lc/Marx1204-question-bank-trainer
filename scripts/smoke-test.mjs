import fs from "node:fs";
import assert from "node:assert/strict";
import { buildDeduplicatedQuestions, parseQuestionBank } from "../js/parser.js";
import { createDefaultState } from "../js/db.js";
import { evaluateSubmission } from "../js/state-machine.js";

function runParserAssertions() {
  const text = fs.readFileSync(new URL("../base.txt", import.meta.url), "utf8");
  const rawQuestions = parseQuestionBank(text);
  const questions = buildDeduplicatedQuestions(rawQuestions);

  assert.equal(rawQuestions.length, 704, "原始解析题目总数应保持为 704");
  assert.equal(questions.length, 573, "去重后题目总数应保持为 573");
  assert.equal(questions[0].stem, "一切唯心主义的共同观点是");
  assert.deepEqual(questions[0].answer, ["C"]);
  const targetMultiQuestion = questions.find((question) => question.id === 31);
  assert.ok(targetMultiQuestion, "去重后仍应保留连续编号 31 的题目");
  assert.equal(targetMultiQuestion.type, "multi");
  assert.deepEqual(targetMultiQuestion.answer, ["A", "D"]);
  assert.equal(questions[questions.length - 1].id, 573);
  const duplicateQuestion = questions.find((question) => (question.duplicateCount ?? 1) > 1);
  assert.ok(duplicateQuestion, "应当至少存在一组重复出现的题目");
  assert.ok((duplicateQuestion.sourceNos?.length ?? 0) >= 2, "重复题应保留原题号列表");
}

function runStateAssertions() {
  const singleQuestion = {
    id: 1,
    answer: ["C"],
  };

  const multiQuestion = {
    id: 31,
    answer: ["A", "D"],
  };

  const fresh = createDefaultState(singleQuestion.id);

  const wrongWithUncertain = evaluateSubmission({
    previousState: fresh,
    question: singleQuestion,
    selected: ["A"],
    mode: "main",
    markedUncertain: true,
    submittedAt: "2026-06-01T12:00:00.000Z",
  });

  assert.equal(wrongWithUncertain.result.isCorrect, false);
  assert.equal(wrongWithUncertain.nextState.mainDone, true);
  assert.equal(wrongWithUncertain.nextState.inWrongBook, true);
  assert.equal(wrongWithUncertain.nextState.inUncertainBook, false);
  assert.equal(wrongWithUncertain.nextState.everWrong, true);
  assert.equal(wrongWithUncertain.nextState.everUncertain, true);
  assert.equal(wrongWithUncertain.nextState.wrongCount, 1);
  assert.equal(wrongWithUncertain.result.addedToWrongBook, true);
  assert.equal(wrongWithUncertain.result.removedFromUncertainBook, true);

  const fixWrong = evaluateSubmission({
    previousState: wrongWithUncertain.nextState,
    question: singleQuestion,
    selected: ["C"],
    mode: "wrong",
    markedUncertain: false,
    submittedAt: "2026-06-01T12:10:00.000Z",
  });

  assert.equal(fixWrong.result.isCorrect, true);
  assert.equal(fixWrong.nextState.inWrongBook, false);
  assert.equal(fixWrong.nextState.everWrong, true);
  assert.equal(fixWrong.result.removedFromWrongBook, true);

  const uncertainOnly = evaluateSubmission({
    previousState: createDefaultState(multiQuestion.id),
    question: multiQuestion,
    selected: ["A", "D"],
    mode: "main",
    markedUncertain: true,
    submittedAt: "2026-06-01T13:00:00.000Z",
  });

  assert.equal(uncertainOnly.result.isCorrect, true);
  assert.equal(uncertainOnly.nextState.inUncertainBook, true);
  assert.equal(uncertainOnly.nextState.everUncertain, true);
  assert.equal(uncertainOnly.result.addedToUncertainBook, true);

  const fixUncertain = evaluateSubmission({
    previousState: uncertainOnly.nextState,
    question: multiQuestion,
    selected: ["A", "D"],
    mode: "uncertain",
    markedUncertain: false,
    submittedAt: "2026-06-01T13:10:00.000Z",
  });

  assert.equal(fixUncertain.result.isCorrect, true);
  assert.equal(fixUncertain.nextState.inUncertainBook, false);
  assert.equal(fixUncertain.nextState.everUncertain, true);
  assert.equal(fixUncertain.result.removedFromUncertainBook, true);

  const snapshot = {
    kind: "marx-question-bank-progress",
    version: 1,
    sourceInfo: { hash: "src_demo" },
    states: [fixWrong.nextState, fixUncertain.nextState],
    attempts: [wrongWithUncertain.attempt, fixWrong.attempt, uncertainOnly.attempt, fixUncertain.attempt],
    viewState: {
      currentMode: "review",
      focusByMode: {
        main: 2,
        wrong: null,
        uncertain: null,
        review: 31,
      },
      reviewAnswerVisible: true,
    },
  };

  assert.equal(snapshot.kind, "marx-question-bank-progress");
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.states.length, 2);
  assert.equal(snapshot.attempts.length, 4);
  assert.equal(snapshot.viewState.currentMode, "review");
}

runParserAssertions();
runStateAssertions();

console.log("Smoke tests passed.");
