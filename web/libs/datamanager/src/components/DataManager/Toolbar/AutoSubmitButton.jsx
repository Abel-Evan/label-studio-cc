import { inject } from "mobx-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@humansignal/ui";
import { Spinner } from "../../Common/Spinner";

/** Regions scoring below this value block the auto-submission of their task. */
const SCORE_THRESHOLD = 0.9;
const TASKS_PAGE_SIZE = 100;

const injector = inject(({ store }) => ({ store }));

const overlayStyle = {
  position: "fixed",
  inset: 0,
  zIndex: 99999,
  background: "rgba(0, 0, 0, 0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const cardStyle = {
  background: "#fff",
  borderRadius: 8,
  padding: "24px 40px",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 12,
  boxShadow: "0 8px 32px rgba(0, 0, 0, 0.25)",
};

const titleStyle = {
  fontSize: 16,
  fontWeight: 600,
  color: "#1f1f1f",
};

const lineStyle = {
  fontSize: 13,
  color: "#666",
};

const isOkResponse = (response) => {
  if (!response || response.error) return false;
  const status = response.$meta?.status ?? response.status;

  return status === undefined || status < 400;
};

/** Collects every result object the View Task Source dialog shows (annotations + predictions). */
const collectResultItems = (source) => {
  const items = [];

  for (const annotation of source?.annotations ?? []) {
    if (Array.isArray(annotation?.result)) items.push(...annotation.result);
  }
  for (const prediction of source?.predictions ?? []) {
    if (Array.isArray(prediction?.result)) items.push(...prediction.result);
  }
  return items;
};

/**
 * Result objects sharing the same id form one group (a region plus its
 * per-region controls). Every group must expose a numeric score and all
 * scores of the group must be >= SCORE_THRESHOLD, otherwise the task is
 * not eligible for auto-submission.
 */
const allScoresPassThreshold = (items) => {
  const groups = new Map();

  for (const item of items) {
    if (!item || typeof item !== "object" || item.id === undefined || item.id === null) continue;
    if (!groups.has(item.id)) groups.set(item.id, []);
    groups.get(item.id).push(item);
  }

  if (groups.size === 0) return false;

  for (const group of groups.values()) {
    const scores = group
      .map((item) => item.score)
      .filter((score) => typeof score === "number" && Number.isFinite(score));

    if (scores.length === 0) return false;
    if (!scores.every((score) => score >= SCORE_THRESHOLD)) return false;
  }
  return true;
};

/** Paginates GET /api/tasks to collect every task id of the project. */
const fetchAllTaskIds = async (store, projectId) => {
  const ids = [];
  let page = 1;

  for (;;) {
    const response = await store.apiCall(
      "tasks",
      { project: projectId, page, page_size: TASKS_PAGE_SIZE },
      {},
      // errors are counted by the loop - no blocking modal per page
      { errorHandler: () => true },
    );
    const tasks = Array.isArray(response?.tasks) ? response.tasks : [];

    if (!isOkResponse(response) || tasks.length === 0) break;
    for (const task of tasks) ids.push(task.id);

    const total = Number(response?.total ?? ids.length);

    if (ids.length >= total) break;
    page += 1;
  }
  return ids;
};

/**
 * Mirrors the labeling view Submit button at the REST level:
 * existing annotation => updateAnnotation (PATCH), otherwise
 * submitAnnotation (POST) with the draft/prediction result,
 * exactly like LSFWrapper.prepareData serializes it.
 */
const submitTaskAnnotation = async (store, source) => {
  const taskID = source.id;
  const annotation = (source.annotations ?? []).find((item) => item?.id != null);

  if (annotation) {
    return store.apiCall(
      "updateAnnotation",
      { annotationID: annotation.id },
      { body: { result: annotation.result ?? [], lead_time: annotation.lead_time ?? 0 } },
      { errorHandler: () => true },
    );
  }

  const draft = (source.drafts ?? []).find((item) => item?.id != null);
  const prediction = (source.predictions ?? []).find((item) => item?.id != null);
  const body = {
    result: draft?.result ?? prediction?.result ?? [],
    lead_time: 0,
    draft_id: draft?.id ?? null,
  };

  if (prediction) body.parent_prediction = prediction.id;

  return store.apiCall("submitAnnotation", { taskID }, { body }, { errorHandler: () => true });
};

export const AutoSubmitButton = injector(({ store, size }) => {
  const runningRef = useRef(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({
    index: 0,
    total: 0,
    taskID: null,
    submitted: 0,
    skipped: 0,
    failed: 0,
  });

  // Guard against accidental refreshes while the submission loop is in flight.
  useEffect(() => {
    if (!running) return undefined;

    const preventReload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", preventReload);
    return () => window.removeEventListener("beforeunload", preventReload);
  }, [running]);

  const handleClick = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);

    const stats = { submitted: 0, skipped: 0, failed: 0 };
    const syncProgress = (index, total, taskID) => {
      setProgress({ index, total, taskID, ...stats });
    };

    try {
      const projectId = store.project?.id ?? store.SDK?.projectId;
      const taskIds = await fetchAllTaskIds(store, projectId);

      syncProgress(0, taskIds.length, null);

      for (let index = 0; index < taskIds.length; index++) {
        const taskID = taskIds[index];

        syncProgress(index + 1, taskIds.length, taskID);

        try {
          // Same payload as the View Task Source dialog: full task with annotations/predictions.
          const source = await store.apiCall("task", { taskID }, {}, { errorHandler: () => true });

          if (!isOkResponse(source) || source?.id === undefined) {
            stats.failed += 1;
            continue;
          }
          if (!allScoresPassThreshold(collectResultItems(source))) {
            stats.skipped += 1;
            continue;
          }

          const response = await submitTaskAnnotation(store, source);

          if (isOkResponse(response)) stats.submitted += 1;
          else stats.failed += 1;
        } catch {
          // Submission failed: move on to the next task.
          stats.failed += 1;
        }
        syncProgress(index + 1, taskIds.length, taskID);
      }
    } finally {
      runningRef.current = false;
      setRunning(false);

      try {
        await store.fetchProject({ force: true });
        await store.currentView?.reload({ interaction: "refresh" });
      } catch {
        // table refresh is best-effort
      }

      store.SDK?.invoke?.("toast", {
        message: `Auto submit finished: ${stats.submitted} submitted, ${stats.skipped} skipped, ${stats.failed} failed`,
        type: "info",
        duration: 8000,
      });
    }
  }, [store]);

  return (
    <>
      <Button
        size={size ?? "small"}
        look="outlined"
        variant="neutral"
        disabled={running}
        aria-label="Auto submit tasks"
        data-testid="dm-auto-submit-button"
        onClick={handleClick}
      >
        Auto Submit
      </Button>
      {running
        ? createPortal(
            <div style={overlayStyle} data-testid="dm-auto-submit-overlay">
              <div style={cardStyle}>
                <Spinner size="middle" />
                <div style={titleStyle}>正在自动提交中，请勿刷新</div>
                <div style={lineStyle}>
                  {progress.total > 0
                    ? `Task #${progress.taskID ?? "-"} (${progress.index}/${progress.total})`
                    : "Loading tasks..."}
                </div>
                <div style={lineStyle}>
                  {`submitted ${progress.submitted} / skipped ${progress.skipped} / failed ${progress.failed}`}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
});
