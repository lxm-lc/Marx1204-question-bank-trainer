const DB_NAME = "marx-question-bank";
const DB_VERSION = 1;

const STORE_QUESTIONS = "questions";
const STORE_STATES = "question_states";
const STORE_ATTEMPTS = "attempts";
const STORE_META = "meta";

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function openDatabase() {
  const request = indexedDB.open(DB_NAME, DB_VERSION);

  request.onupgradeneeded = () => {
    const database = request.result;

    if (!database.objectStoreNames.contains(STORE_QUESTIONS)) {
      database.createObjectStore(STORE_QUESTIONS, { keyPath: "id" });
    }

    if (!database.objectStoreNames.contains(STORE_STATES)) {
      database.createObjectStore(STORE_STATES, { keyPath: "questionId" });
    }

    if (!database.objectStoreNames.contains(STORE_ATTEMPTS)) {
      const store = database.createObjectStore(STORE_ATTEMPTS, { keyPath: "id", autoIncrement: true });
      store.createIndex("questionId", "questionId", { unique: false });
      store.createIndex("mode", "mode", { unique: false });
      store.createIndex("submittedAt", "submittedAt", { unique: false });
    }

    if (!database.objectStoreNames.contains(STORE_META)) {
      database.createObjectStore(STORE_META, { keyPath: "key" });
    }
  };

  return promisifyRequest(request);
}

export async function getAllQuestions(database) {
  const transaction = database.transaction(STORE_QUESTIONS, "readonly");
  const store = transaction.objectStore(STORE_QUESTIONS);
  const result = await promisifyRequest(store.getAll());
  return result.sort((left, right) => left.id - right.id);
}

export async function getQuestionById(database, questionId) {
  const transaction = database.transaction(STORE_QUESTIONS, "readonly");
  return promisifyRequest(transaction.objectStore(STORE_QUESTIONS).get(questionId));
}

export async function getAllStates(database) {
  const transaction = database.transaction(STORE_STATES, "readonly");
  const result = await promisifyRequest(transaction.objectStore(STORE_STATES).getAll());
  return result.sort((left, right) => left.questionId - right.questionId);
}

export async function getAllAttempts(database) {
  const transaction = database.transaction(STORE_ATTEMPTS, "readonly");
  const result = await promisifyRequest(transaction.objectStore(STORE_ATTEMPTS).getAll());
  return result.sort((left, right) => left.id - right.id);
}

export async function getStateByQuestionId(database, questionId) {
  const transaction = database.transaction(STORE_STATES, "readonly");
  return promisifyRequest(transaction.objectStore(STORE_STATES).get(questionId));
}

export async function putState(database, state) {
  const transaction = database.transaction(STORE_STATES, "readwrite");
  transaction.objectStore(STORE_STATES).put(state);
  await transactionDone(transaction);
}

export async function addAttempt(database, attempt) {
  const transaction = database.transaction(STORE_ATTEMPTS, "readwrite");
  const request = transaction.objectStore(STORE_ATTEMPTS).add(attempt);
  const id = await promisifyRequest(request);
  await transactionDone(transaction);
  return id;
}

export async function getAttemptsByQuestionId(database, questionId) {
  const transaction = database.transaction(STORE_ATTEMPTS, "readonly");
  const index = transaction.objectStore(STORE_ATTEMPTS).index("questionId");
  const attempts = await promisifyRequest(index.getAll(IDBKeyRange.only(questionId)));
  return attempts.sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));
}

export async function getMeta(database, key) {
  const transaction = database.transaction(STORE_META, "readonly");
  const result = await promisifyRequest(transaction.objectStore(STORE_META).get(key));
  return result ? result.value : null;
}

export async function setMeta(database, key, value) {
  const transaction = database.transaction(STORE_META, "readwrite");
  transaction.objectStore(STORE_META).put({ key, value });
  await transactionDone(transaction);
}

export async function seedDatabase(database, questions, sourceInfo) {
  await replaceQuestionBank(database, {
    questions,
    states: questions.map((question) => createDefaultState(question.id)),
    attempts: [],
    sourceInfo,
    viewState: {
      currentMode: "main",
      focusByMode: {
        main: questions[0]?.id ?? null,
        wrong: null,
        uncertain: null,
        review: questions[0]?.id ?? null,
      },
      reviewAnswerVisible: false,
    },
  });
}

export async function replaceQuestionBank(database, { questions, states, attempts, sourceInfo, viewState }) {
  const transaction = database.transaction(
    [STORE_QUESTIONS, STORE_STATES, STORE_ATTEMPTS, STORE_META],
    "readwrite",
  );

  const questionStore = transaction.objectStore(STORE_QUESTIONS);
  const stateStore = transaction.objectStore(STORE_STATES);
  const attemptStore = transaction.objectStore(STORE_ATTEMPTS);
  const metaStore = transaction.objectStore(STORE_META);

  questionStore.clear();
  stateStore.clear();
  attemptStore.clear();

  for (const question of questions) {
    questionStore.put(question);
  }

  for (const state of states) {
    stateStore.put(state);
  }

  for (const attempt of attempts) {
    attemptStore.put(attempt);
  }

  metaStore.put({ key: "sourceInfo", value: sourceInfo });
  metaStore.put({ key: "viewState", value: viewState });

  await transactionDone(transaction);
}

export async function clearAllProgress(database) {
  const questions = await getAllQuestions(database);
  const sourceInfo = await getMeta(database, "sourceInfo");
  await seedDatabase(database, questions, sourceInfo);
}

export async function restartMainProgress(database) {
  const states = await getAllStates(database);
  const transaction = database.transaction([STORE_STATES, STORE_META], "readwrite");
  const stateStore = transaction.objectStore(STORE_STATES);
  const metaStore = transaction.objectStore(STORE_META);

  for (const state of states) {
    stateStore.put({
      ...state,
      mainDone: false,
    });
  }

  metaStore.put({
    key: "viewState",
    value: {
      currentMode: "main",
      focusByMode: {
        main: 1,
        wrong: null,
        uncertain: null,
        review: 1,
      },
      reviewAnswerVisible: false,
    },
  });

  await transactionDone(transaction);
}

export async function clearEntireDatabase(database) {
  const transaction = database.transaction(
    [STORE_QUESTIONS, STORE_STATES, STORE_ATTEMPTS, STORE_META],
    "readwrite",
  );
  transaction.objectStore(STORE_QUESTIONS).clear();
  transaction.objectStore(STORE_STATES).clear();
  transaction.objectStore(STORE_ATTEMPTS).clear();
  transaction.objectStore(STORE_META).clear();
  await transactionDone(transaction);
}

export async function restoreProgressSnapshot(database, snapshot) {
  const transaction = database.transaction(
    [STORE_QUESTIONS, STORE_STATES, STORE_ATTEMPTS, STORE_META],
    "readwrite",
  );

  const stateStore = transaction.objectStore(STORE_STATES);
  const attemptStore = transaction.objectStore(STORE_ATTEMPTS);
  const metaStore = transaction.objectStore(STORE_META);

  stateStore.clear();
  attemptStore.clear();

  for (const state of snapshot.states) {
    stateStore.put(state);
  }

  for (const attempt of snapshot.attempts) {
    attemptStore.put(attempt);
  }

  metaStore.put({ key: "viewState", value: snapshot.viewState });
  await transactionDone(transaction);
}

export function createDefaultState(questionId) {
  return {
    questionId,
    mainDone: false,
    lastSelected: [],
    lastCorrect: null,
    lastMode: null,
    lastSubmittedAt: null,
    note: "",
    wrongBookOrderAt: null,
    uncertainBookOrderAt: null,
    inWrongBook: false,
    inUncertainBook: false,
    everWrong: false,
    everUncertain: false,
    wrongCount: 0,
    attemptCount: 0,
  };
}
