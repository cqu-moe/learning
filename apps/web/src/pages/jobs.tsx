import { useRef, useState } from "react";
import {
  Link,
  useLoaderData,
  useRevalidator,
  useSearchParams,
} from "react-router";
import {
  ArrowLeft,
  CirclePause,
  CirclePlay,
  Download,
  RefreshCw,
  Square,
} from "lucide-react";
import {
  ActionButton,
  Alert,
  AlertTitle,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  PageHeader,
  PageState,
  toast,
} from "@cqu-moe/ui";
import { JobSchema } from "@learning/sdk/public";
import type { Job, JobEvent } from "@learning/sdk/public";
import { useDashboard } from "../data.ts";
import {
  activeStatuses,
  attentionStatuses,
  Failure,
  formatTime,
  JobProgress,
  JobRow,
  jobKinds,
  platforms,
  Status,
  statuses,
} from "../components.tsx";
import { ReconcileResultSchema } from "../../shared/contracts.ts";
import type { JobDetail } from "../../shared/contracts.ts";
import { api, errorMessage } from "../api.ts";

export function Jobs() {
  const data = useDashboard();
  const [params, setParams] = useSearchParams();
  const filter = params.get("filter") ?? "all";
  const { revalidate, state } = useRevalidator();
  const jobs = [...data.jobs]
    .filter(
      (job) =>
        filter === "all" ||
        (filter === "active"
          ? activeStatuses.includes(job.status)
          : filter === "attention"
            ? attentionStatuses.includes(job.status)
            : filter === "paused"
              ? job.status === "paused"
              : ["succeeded", "canceled"].includes(job.status)),
    )
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  return (
    <>
      <PageHeader
        title="任务中心"
        description="进度、结果和需要你处理的事情，都在这里。"
        actions={
          <Button
            variant="outline"
            disabled={state !== "idle"}
            onClick={() => void revalidate()}
          >
            <RefreshCw aria-hidden="true" />
            {state === "idle" ? "刷新任务" : "正在刷新…"}
          </Button>
        }
      />
      <div className="filter-group" role="group" aria-label="按任务状态筛选">
        {[
          ["all", "全部任务"],
          ["active", "进行中"],
          ["attention", "需要处理"],
          ["paused", "已暂停"],
          ["done", "已结束"],
        ].map(([value, label]) => (
          <Button
            key={value}
            variant={filter === value ? "secondary" : "ghost"}
            aria-pressed={filter === value}
            onClick={() => setParams(value === "all" ? {} : { filter: value! })}
          >
            {label}
          </Button>
        ))}
      </div>
      <div className="list-caption" aria-live="polite">
        <span>{jobs.length} 项任务</span>
        <span>本机执行记录</span>
      </div>
      <div className="surface">
        {jobs.length ? (
          jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              profile={data.profiles.find(
                (p) => p.scope.profileId === job.scope.profileId,
              )}
            />
          ))
        ) : (
          <PageState
            state="empty"
            title={data.jobs.length ? "这个分类下没有任务" : "还没有任务记录"}
            description={
              data.jobs.length
                ? "可以切换分类查看其他任务。"
                : "本机运行过的学习、导出和课堂任务会显示在这里。"
            }
            action={
              data.jobs.length ? (
                filter !== "all" ? (
                  <Button variant="outline" onClick={() => setParams({})}>
                    查看全部任务
                  </Button>
                ) : undefined
              ) : (
                <Button asChild variant="outline">
                  <Link to="/courses">去课程新建任务</Link>
                </Button>
              )
            }
          />
        )}
      </div>
      <p className="page-note">
        运行中的状态每 5 秒更新。暂停会停止后续操作，已经发生的结果会保留。
      </p>
    </>
  );
}

const itemStates: Record<Job["items"][number]["state"], string> = {
  succeeded: "已完成",
  failed: "未完成",
  partial: "部分完成",
  skipped: "已跳过",
  "needs-input": "需要处理",
  uncertain: "结果待核对",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function eventDescription(event: JobEvent, jobKind: Job["kind"]): string {
  switch (event.type) {
    case "state":
      return `状态更新：${statuses[event.job.status]}`;
    case "progress": {
      const title = event.title ?? "未命名资源";
      const fraction =
        event.serverFraction === null
          ? "平台进度未提供"
          : `${Math.round(event.serverFraction * 100)}%`;
      const estimated =
        event.estimatedSeconds === null
          ? ""
          : ` · 预计 ${Math.ceil(event.estimatedSeconds / 60)} 分钟`;
      return `${title} · ${fraction}${estimated}`;
    }
    case "question":
      return jobKind === "live"
        ? "收到课堂题目，请在平台查看并处理"
        : "收到题目，任务已暂停等待处理";
    case "gap":
      return event.message;
  }
}

export function JobDetail() {
  const detail = useLoaderData<JobDetail>();
  const { job, active, error: executorError, events, itemTitles } = detail;
  const profile = useDashboard().profiles.find(
    (p) => p.scope.profileId === job.scope.profileId,
  );
  const { revalidate } = useRevalidator();
  const [pending, setPending] = useState<
    "pause" | "cancel" | "resume" | null
  >(null);
  const submitting = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const canPause = active && activeStatuses.includes(job.status);
  const needsReconcile =
    job.status === "uncertain" ||
    (!active && job.status === "running" && job.kind === "study");
  const canCancel =
    !needsReconcile &&
    (activeStatuses.includes(job.status) ||
      ["paused", "needs-input"].includes(job.status));
  const canResume =
    !needsReconcile &&
    (job.status === "needs-input"
      ? ["study", "live"].includes(job.kind)
      : !active &&
        (["paused", "queued", "waiting"].includes(job.status) ||
          (job.status === "running" && ["export", "live"].includes(job.kind))));

  async function control(action: "pause" | "cancel" | "resume") {
    if (submitting.current) return;
    submitting.current = true;
    setPending(action);
    setError(null);
    try {
      await api(`/jobs/${encodeURIComponent(job.id)}/control`, JobSchema, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      if (action === "cancel") setCancelOpen(false);
      if (action === "resume") setResumeOpen(false);
      const messages = {
        pause: "任务已暂停",
        cancel: "任务已取消",
        resume: "任务已恢复",
      } as const;
      toast.success(messages[action]);
      void revalidate().catch(() =>
        toast.error("操作已完成，但任务状态刷新失败。请刷新页面。"),
      );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      submitting.current = false;
      setPending(null);
    }
  }

  async function reconcile() {
    if (submitting.current || reconciling) return;
    submitting.current = true;
    setReconciling(true);
    setError(null);
    try {
      const result = await api(
        `/jobs/${encodeURIComponent(job.id)}/reconcile`,
        ReconcileResultSchema,
        { method: "POST", body: "{}" },
      );
      if (result.state === "confirmed") toast.success(result.message);
      else if (result.state === "uncertain") toast.warning(result.message);
      else toast.error(result.message);
      void revalidate().catch(() =>
        toast.error("核对请求已完成，但任务状态刷新失败。请刷新页面。"),
      );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      submitting.current = false;
      setReconciling(false);
    }
  }
  return (
    <>
      <Link to="/jobs" className="back-link">
        <ArrowLeft size={16} aria-hidden="true" />
        任务中心
      </Link>
      <PageHeader
        title={jobKinds[job.kind]}
        description={`${profile?.name ?? platforms[job.scope.platform]} · 创建于 ${formatTime(job.createdAtMs)}`}
        actions={
          <div className="actions">
            {canPause && (
              <Button
                variant="outline"
                disabled={pending !== null || reconciling}
                onClick={() => void control("pause")}
              >
                <CirclePause aria-hidden="true" />
                {pending === "pause" ? "正在暂停…" : "暂停任务"}
              </Button>
            )}
            {needsReconcile && (
              <Button
                disabled={pending !== null || reconciling}
                onClick={() => void reconcile()}
              >
                <RefreshCw aria-hidden="true" />
                {reconciling ? "正在核对…" : "核对任务结果"}
              </Button>
            )}
            {canResume && (
              <Button
                disabled={pending !== null || reconciling}
                onClick={() => {
                  if (job.kind === "live") setResumeOpen(true);
                  else void control("resume");
                }}
              >
                <CirclePlay aria-hidden="true" />
                {pending === "resume" ? "正在恢复…" : "恢复任务"}
              </Button>
            )}
          </div>
        }
      />
      {error && !cancelOpen && !resumeOpen && <Failure message={error} />}
      {job.status === "uncertain" && (
        <Alert>
          <AlertTitle>执行结果需要核对</AlertTitle>
          <AlertDescription>
            平台响应没有得到确认。请核对平台上的实际结果，再在本页核对任务结果，避免重复提交。
          </AlertDescription>
        </Alert>
      )}
      {job.status === "needs-input" && (
        <Alert>
          <AlertTitle>任务在等待你的处理</AlertTitle>
          <AlertDescription>
            查看下方项目结果，按提示完成必要的验证或处理。任务不会自动猜测答案。
          </AlertDescription>
        </Alert>
      )}
      <section className="surface job-detail-summary">
        <div>
          <span className="muted small">当前状态</span>
          <Status status={job.status} />
        </div>
        <JobProgress job={job} />
        <div>
          <span className="muted small">最后更新</span>
          <span>{formatTime(job.updatedAtMs)}</span>
        </div>
      </section>
      <section className="surface execution-panel" aria-label="运行状态">
        <div>
          <span className="muted small">运行状态</span>
          <strong>{active ? "正在本机执行" : "当前未运行"}</strong>
        </div>
        <p>
          {needsReconcile
            ? "核对上次执行结果后，才能继续此任务。"
            : canResume
              ? "这项任务可以在本机继续执行。"
              : active
                ? "任务正在这台设备上运行。"
                : "可查看下方的执行记录和导出文件。"}
        </p>
        {executorError && <Failure message={executorError} />}
      </section>
      <section>
        <div className="section-heading">
          <div>
            <h2>最新事件</h2>
            <p>查看最近的执行进展</p>
          </div>
        </div>
        <div className="surface">
          {events.length ? (
            <ul className="event-list">
              {[...events]
                .sort((a, b) => b.sequence - a.sequence)
                .slice(0, 6)
                .map((event) => (
                  <li key={`${event.type}-${event.sequence}`}>
                    <span className="muted small">#{event.sequence}</span>
                    <span>{eventDescription(event, job.kind)}</span>
                  </li>
                ))}
            </ul>
          ) : (
            <PageState
              state="empty"
              title="还没有事件记录"
              description="任务产生真实进度后会显示在这里。"
            />
          )}
        </div>
      </section>
      {job.warnings.length > 0 && (
        <Alert>
          <AlertTitle>任务提示</AlertTitle>
          <AlertDescription>
            <ul>
              {job.warnings.map((warning, index) => (
                <li key={index}>{warning.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      <section>
        <div className="section-heading">
          <div>
            <h2>项目结果</h2>
            <p>保留完成、跳过与需要处理的记录</p>
          </div>
        </div>
        <div className="surface">
          {job.items.length ? (
            <ul className="result-list">
              {job.items.map((item, index) => (
                <li key={`${item.key}-${index}`}>
                  <div>
                    <strong>{itemTitles[item.key] || `项目 ${index + 1}`}</strong>
                    <span className="status">{itemStates[item.state]}</span>
                  </div>
                  {item.message && <p>{item.message}</p>}
                  {item.artifacts.length > 0 && (
                    <div className="artifact-list">
                      {item.artifacts.map((artifact) => (
                        <Button
                          key={artifact.id}
                          asChild
                          variant="ghost"
                          size="sm"
                        >
                          <a
                            href={`/api/jobs/${encodeURIComponent(job.id)}/artifacts/${encodeURIComponent(artifact.id)}`}
                            download={artifact.filename}
                            title={artifact.filename}
                          >
                            <Download aria-hidden="true" />
                            下载{artifact.filename.endsWith(".transcript.json") ? "字幕" : "文件"} · {formatBytes(artifact.bytes)}
                          </a>
                        </Button>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <PageState
              state="empty"
              title="还没有项目结果"
              description="任务产生结果后，会在这里逐项记录。"
            />
          )}
        </div>
      </section>
      {canResume && job.kind === "live" && (
        <Dialog
          open={resumeOpen}
          onOpenChange={(open) => {
            if (!submitting.current) {
              setResumeOpen(open);
              setError(null);
            }
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>重新签到这门课堂？</DialogTitle>
              <DialogDescription>
                恢复课堂任务会重新进入课堂并继续接收事件；已发生的课堂记录不会回滚。
              </DialogDescription>
            </DialogHeader>
            {error && <Failure message={error} />}
            <DialogFooter>
              <Button
                variant="outline"
                disabled={pending !== null}
                onClick={() => setResumeOpen(false)}
              >
                暂不恢复
              </Button>
              <ActionButton
                state={pending === "resume" ? "loading" : error ? "error" : "idle"}
                labels={{
                  idle: "重新签到并继续",
                  loading: "正在恢复…",
                  success: "已恢复",
                  error: "重试恢复",
                }}
                onClick={() => void control("resume")}
              />
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {canCancel && (
        <div className="cancel-section">
          <div>
            <h3>不再继续这项任务？</h3>
            <p>取消后不会回滚已完成的操作。</p>
          </div>
          <Dialog
            open={cancelOpen}
            onOpenChange={(open) => {
              if (!submitting.current) {
                setCancelOpen(open);
                setError(null);
              }
            }}
          >
            <DialogTrigger asChild>
              <Button variant="outline">
                <Square aria-hidden="true" />
                取消任务
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>取消这项任务？</DialogTitle>
                <DialogDescription>
                  后续操作将停止，已完成的操作和结果会保留。
                </DialogDescription>
              </DialogHeader>
              {error && <Failure message={error} />}
              <DialogFooter>
                <Button
                  variant="outline"
                  disabled={pending !== null}
                  onClick={() => setCancelOpen(false)}
                >
                  保留任务
                </Button>
                <ActionButton
                  variant="destructive"
                  state={
                    pending === "cancel" ? "loading" : error ? "error" : "idle"
                  }
                  labels={{
                    idle: "确认取消",
                    loading: "正在取消…",
                    success: "已取消",
                    error: "重试取消",
                  }}
                  onClick={() => void control("cancel")}
                />
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}
    </>
  );
}
