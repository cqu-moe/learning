import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useRevalidator } from "react-router";
import {
  ActionButton,
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  PageState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@cqu-moe/ui";
import { CircleAlert, Play, Plus } from "lucide-react";
import { z } from "zod";
import { JobSchema } from "@learning/sdk/public";
import type { Lesson, OutlineNode, Platform, Resource } from "@learning/sdk/public";
import { LessonPageSchema, TaskInputSchema, TaskPreviewSchema } from "../../shared/contracts.ts";
import type { TaskInput, TaskPreview } from "../../shared/contracts.ts";
import { api, errorMessage } from "../api.ts";
import { Failure, platforms } from "../components.tsx";

type TaskKind = TaskInput["kind"];
type LessonPage = z.infer<typeof LessonPageSchema>;

const taskChoices: { kind: TaskKind; label: string; description: string }[] = [
  { kind: "study", label: "学习资源", description: "视频和文档内容" },
  { kind: "media", label: "导出媒体", description: "下载视频与字幕" },
  { kind: "assessments", label: "导出作业", description: "只读导出，不提交答案" },
  { kind: "slides", label: "导出课件", description: "雨课堂课堂课件" },
  { kind: "live", label: "课堂任务", description: "进入课堂并保留事件" },
];

const taskLabels: Record<TaskKind, string> = Object.fromEntries(
  taskChoices.map((choice) => [choice.kind, choice.label]),
) as Record<TaskKind, string>;

function flattenResources(nodes: OutlineNode[]): { resource: Resource; path: string }[] {
  return nodes.flatMap((node) => [
    ...node.resources.map((resource) => ({
      resource,
      path: resource.path.length ? resource.path.join(" / ") : node.title,
    })),
    ...flattenResources(node.children),
  ]);
}

function accepted(kind: TaskKind, resource: Resource): boolean {
  if (kind === "study") return ["video", "document"].includes(resource.kind);
  if (kind === "media") return resource.kind === "video";
  return resource.kind === "homework";
}

function lessonId(lesson: Lesson): string {
  return lesson.ref.lessonId;
}

export function TaskComposer({
  courseKey,
  courseTitle,
  platform,
  roots,
}: {
  courseKey: string;
  courseTitle: string;
  platform: Platform;
  roots: OutlineNode[];
}) {
  const navigate = useNavigate();
  const { revalidate } = useRevalidator();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<TaskKind>("study");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [speed, setSpeed] = useState("1");
  const [targetPercent, setTargetPercent] = useState("100");
  const [maxMinutes, setMaxMinutes] = useState("120");
  const [quality, setQuality] = useState<"best" | "hd" | "sd">("best");
  const [subtitles, setSubtitles] = useState(false);
  const [format, setFormat] = useState<"json" | "markdown" | "yaml">("markdown");
  const [slidesFormat, setSlidesFormat] = useState<"images" | "pdf">("pdf");
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [lessonState, setLessonState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [lessonError, setLessonError] = useState<string | null>(null);
  const [lessonReload, setLessonReload] = useState(0);
  const [lessonIds, setLessonIds] = useState<Set<string>>(new Set());
  const [liveLessonId, setLiveLessonId] = useState("");
  const [liveMaxMinutes, setLiveMaxMinutes] = useState("120");
  const [preview, setPreview] = useState<TaskPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [startBusy, setStartBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewId = useRef<string | null>(null);
  const previewController = useRef<AbortController | null>(null);
  const startController = useRef<AbortController | null>(null);
  const closeRequested = useRef(false);
  const mounted = useRef(true);

  const resources = useMemo(() => flattenResources(roots), [roots]);
  const eligibleResources = resources.filter(
    (item) => accepted(kind, item.resource) && item.resource.locked !== true,
  );
  const speedLimit = platform === "zhs" ? (resources.some(({ resource }) => resource.ref.native.kind === "zhs-hike") ? 1.25 : 1.5) : 5;
  const choices = eligibleResources;
  const visibleLessons = lessons;

  useEffect(
    () => () => {
      mounted.current = false;
      const starting = startController.current !== null;
      previewController.current?.abort();
      const id = previewId.current;
      previewId.current = null;
      if (id && !starting) {
        void api(`/tasks/${encodeURIComponent(id)}`, z.unknown(), {
          method: "DELETE",
          body: "{}",
          keepalive: true,
        }).catch(() => undefined);
      }
    },
    [],
  );

  useEffect(() => {
    if (!open || (kind !== "slides" && kind !== "live")) return;
    const controller = new AbortController();
    setLessonState("loading");
    setLessonError(null);
    async function load() {
      try {
        let cursor: string | null = null;
        const loaded: Lesson[] = [];
        do {
          const page: LessonPage = await api(
            `/courses/${encodeURIComponent(courseKey)}/lessons${
              cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""
            }`,
            LessonPageSchema,
            { signal: controller.signal },
          );
          if (controller.signal.aborted) return;
          loaded.push(...page.items);
          setLessons([...loaded]);
          cursor = page.nextCursor;
        } while (cursor !== null);
        if (!controller.signal.aborted) setLessonState("success");
      } catch (failure) {
        if (!controller.signal.aborted) {
          setLessonState("error");
          setLessonError(errorMessage(failure));
        }
      }
    }
    void load();
    return () => controller.abort();
  }, [courseKey, kind, lessonReload, open]);

  function invalidatePreview() {
    const id = previewId.current;
    if (id === null) return;
    previewId.current = null;
    setPreview(null);
    void api(`/tasks/${encodeURIComponent(id)}`, z.unknown(), {
      method: "DELETE",
      body: "{}",
      keepalive: true,
    }).catch(() => undefined);
  }

  function chooseKind(value: string) {
    setKind(value as TaskKind);
    setSelected(new Set());
    setLessonIds(new Set());
    setLiveLessonId("");
    setError(null);
    invalidatePreview();
  }

  function changeNumber(value: string, set: (value: string) => void) {
    set(value);
    setError(null);
    invalidatePreview();
  }

  function toggleResource(key: string, checked: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked && next.size < 500) next.add(key);
      if (!checked) next.delete(key);
      return next;
    });
    setError(null);
    invalidatePreview();
  }

  function toggleLessons(checked: boolean) {
    setLessonIds(
      checked ? new Set(lessons.slice(0, 500).map(lessonId)) : new Set(),
    );
    setError(null);
    invalidatePreview();
  }

  function makeInput(): unknown {
    const keys = [...selected].slice(0, 500);
    switch (kind) {
      case "study":
        return {
          kind,
          courseKey,
          resourceKeys: keys,
          speed: Number(speed),
          targetPercent: Number(targetPercent),
          maxMinutes: Number(maxMinutes),
        };
      case "media":
        return { kind, courseKey, resourceKeys: keys, quality, subtitles };
      case "assessments":
        return { kind, courseKey, resourceKeys: keys, format };
      case "slides":
        return {
          kind,
          courseKey,
          lessonIds: [...lessonIds].slice(0, 500),
          format: slidesFormat,
        };
      case "live":
        return {
          kind,
          courseKey,
          lessonId: liveLessonId,
          maxMinutes: Number(liveMaxMinutes),
        };
    }
  }

  async function makePreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (previewController.current !== null || startController.current !== null) return;
    const parsed = TaskInputSchema.safeParse(makeInput());
    if (!parsed.success) {
      setError("任务参数不符合当前限制，请检查资源、课堂和数值后重试。");
      return;
    }
    invalidatePreview();
    const controller = new AbortController();
    previewController.current = controller;
    setPreviewBusy(true);
    setError(null);
    try {
      const result = await api("/tasks/preview", TaskPreviewSchema, {
        method: "POST",
        body: JSON.stringify(parsed.data),
        signal: controller.signal,
      });
      if (!mounted.current || controller.signal.aborted) {
        void api(`/tasks/${encodeURIComponent(result.id)}`, z.unknown(), {
          method: "DELETE",
          body: "{}",
          keepalive: true,
        }).catch(() => undefined);
        return;
      }
      previewId.current = result.id;
      setPreview(result);
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (previewController.current === controller) {
        previewController.current = null;
        if (mounted.current) setPreviewBusy(false);
      }
    }
  }

  async function start() {
    const id = previewId.current;
    if (id === null || startController.current !== null) return;
    const controller = new AbortController();
    startController.current = controller;
    setStartBusy(true);
    setError(null);
    try {
      const job = await api(`/tasks/${encodeURIComponent(id)}/start`, JobSchema, {
        method: "POST",
        body: "{}",
        signal: controller.signal,
      });
      if (!mounted.current || controller.signal.aborted) return;
      previewId.current = null;
      setPreview(null);
      setOpen(false);
      toast.success(`「${taskLabels[kind]}」任务已启动。`);
      void revalidate().catch(() =>
        toast.error("任务已启动，但列表刷新失败。请刷新页面。"),
      );
      if (!closeRequested.current) {
        navigate(`/jobs/${encodeURIComponent(job.id)}`);
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
      if (closeRequested.current) {
        toast.error(`「${taskLabels[kind]}」任务启动结果未确认，请在任务中心刷新。`);
      }
    } finally {
      if (startController.current === controller) {
        startController.current = null;
        if (mounted.current) setStartBusy(false);
      }
    }
  }

  function closeDialog() {
    const starting = startController.current !== null;
    previewController.current?.abort();
    previewController.current = null;
    if (starting) closeRequested.current = true;
    const id = starting ? null : previewId.current;
    if (!starting) previewId.current = null;
    setOpen(false);
    if (!starting) setPreview(null);
    setPreviewBusy(false);
    setError(null);
    if (id && !starting) {
      void api(`/tasks/${encodeURIComponent(id)}`, z.unknown(), {
        method: "DELETE",
        body: "{}",
        keepalive: true,
      }).catch(() => undefined);
    }
  }

  const canCreatePreview =
    (kind === "slides"
      ? lessonIds.size > 0
      : kind === "live"
        ? liveLessonId !== ""
        : selected.size > 0) && !previewBusy && !startBusy;

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (value) {
          closeRequested.current = false;
          setOpen(true);
        }
        else closeDialog();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus aria-hidden="true" />
          新建任务
        </Button>
      </DialogTrigger>
      <DialogContent className="task-dialog">
        <DialogHeader>
          <DialogTitle>新建课程任务</DialogTitle>
          <DialogDescription>
            {platforms[platform]} · {courseTitle} · 选择内容和参数，确认后开始。
          </DialogDescription>
        </DialogHeader>
        <form className="task-form" onSubmit={(event) => void makePreview(event)}>
          <div className="field">
            <Label htmlFor="task-kind">任务类型</Label>
            <Select value={kind} onValueChange={chooseKind} disabled={previewBusy || startBusy}>
              <SelectTrigger id="task-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {taskChoices.map((choice) => (
                  <SelectItem key={choice.kind} value={choice.kind}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="field-help">
              {taskChoices.find((choice) => choice.kind === kind)?.description}
            </p>
          </div>

          {kind !== "slides" && kind !== "live" && (
            <fieldset className="task-resources">
              <legend className="small">
                可选资源 {choices.length} 项
                {eligibleResources.length > 500 ? "（每次最多选 500）" : ""} · 已选{" "}
                {selected.size} 项
              </legend>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={choices.length === 0 || previewBusy || startBusy}
                onClick={() => {
                  setSelected(new Set(choices.slice(0, 500).map((item) => item.resource.ref.key)));
                  setError(null);
                  invalidatePreview();
                }}
              >
                {choices.length > 500 ? "选择前 500 项" : "全选可用资源"}
              </Button>
              {choices.length ? (
                <div className="task-option-list" role="group" aria-label="选择任务资源">
                  {choices.map(({ resource, path }, index) => (
                    <Label
                      key={resource.ref.key}
                      className="task-option"
                      htmlFor={`task-resource-${index}`}
                    >
                      <Checkbox
                        id={`task-resource-${index}`}
                        aria-label={resource.title || "未命名内容"}
                        checked={selected.has(resource.ref.key)}
                        disabled={previewBusy || startBusy || (selected.size >= 500 && !selected.has(resource.ref.key))}
                        onCheckedChange={(value) =>
                          toggleResource(resource.ref.key, value === true)
                        }
                      />
                      <span>
                        <strong>{resource.title || "未命名内容"}</strong>
                        <small>
                          {path} · {resource.kind === "video" ? "视频" : resource.kind === "document" ? "文档" : "作业"}
                          {resource.durationSeconds === null
                            ? ""
                            : ` · ${Math.ceil(resource.durationSeconds / 60)} 分钟`}
                        </small>
                      </span>
                    </Label>
                  ))}
                </div>
              ) : (
                <p className="field-help">这门课程没有适合当前任务的可用资源。</p>
              )}
            </fieldset>
          )}

          {kind === "study" && (
            <div className="task-settings">
              <div className="field">
                <Label htmlFor="task-speed">倍速（1–{speedLimit}）</Label>
                <Input
                  id="task-speed"
                  type="number"
                  min={1}
                  max={speedLimit}
                  step={platform === "zhs" ? "any" : 1}
                  required
                  value={speed}
                  disabled={previewBusy || startBusy}
                  onChange={(event) => changeNumber(event.target.value, setSpeed)}
                />
              </div>
              <div className="field">
                <Label htmlFor="task-target">目标进度（1–100%）</Label>
                <Input
                  id="task-target"
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  required
                  value={targetPercent}
                  disabled={previewBusy || startBusy}
                  onChange={(event) => changeNumber(event.target.value, setTargetPercent)}
                />
              </div>
              <div className="field">
                <Label htmlFor="task-minutes">最长运行（分钟）</Label>
                <Input
                  id="task-minutes"
                  type="number"
                  min={1}
                  max={1440}
                  step={1}
                  required
                  value={maxMinutes}
                  disabled={previewBusy || startBusy}
                  onChange={(event) => changeNumber(event.target.value, setMaxMinutes)}
                />
              </div>
              <p className="field-help task-settings-note">遇到题目会暂停，不猜测答案。</p>
            </div>
          )}

          {kind === "media" && (
            <div className="task-settings">
              <div className="field">
                <Label htmlFor="task-quality">媒体质量</Label>
                <Select
                  value={quality}
                  onValueChange={(value) => {
                    setQuality(value as typeof quality);
                    setError(null);
                    invalidatePreview();
                  }}
                  disabled={previewBusy || startBusy}
                >
                  <SelectTrigger id="task-quality">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="best">最佳</SelectItem>
                    <SelectItem value="hd">高清</SelectItem>
                    <SelectItem value="sd">标清</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Label className="task-option task-option-single" htmlFor="task-subtitles">
                <Checkbox
                  id="task-subtitles"
                  checked={subtitles}
                  disabled={previewBusy || startBusy}
                  onCheckedChange={(value) => {
                    setSubtitles(value === true);
                    setError(null);
                    invalidatePreview();
                  }}
                />
                <span>同时导出可用字幕</span>
              </Label>
            </div>
          )}

          {(kind === "assessments" || kind === "slides") && (
            <div className="field">
              <Label htmlFor="task-format">导出格式</Label>
              <Select
                value={kind === "assessments" ? format : slidesFormat}
                onValueChange={(value) => {
                  if (kind === "assessments") setFormat(value as typeof format);
                  else setSlidesFormat(value as typeof slidesFormat);
                  setError(null);
                  invalidatePreview();
                }}
                disabled={previewBusy || startBusy}
              >
                <SelectTrigger id="task-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {kind === "assessments" ? (
                    <>
                      <SelectItem value="json">JSON</SelectItem>
                      <SelectItem value="markdown">Markdown</SelectItem>
                      <SelectItem value="yaml">YAML</SelectItem>
                    </>
                  ) : (
                    <>
                      <SelectItem value="images">图片</SelectItem>
                      <SelectItem value="pdf">PDF</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          {(kind === "slides" || kind === "live") && (
            <fieldset className="task-resources">
              <legend className="small">
                {kind === "slides"
                  ? `课堂课件 ${visibleLessons.length} 项${
                      lessons.length > 500 ? "（每次最多选 500）" : ""
                    } · 已选 ${lessonIds.size} 项`
                  : "选择课堂"}
              </legend>
              {lessonState === "loading" && (
                <PageState state="loading" title="正在读取课堂" description="请稍候。" />
              )}
              {lessonState === "error" && (
                <Failure
                  message={lessonError ?? "课堂读取失败。"}
                  retry={() => setLessonReload((value) => value + 1)}
                />
              )}
              {lessonState === "success" && kind === "slides" && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={visibleLessons.length === 0 || previewBusy || startBusy}
                    onClick={() => toggleLessons(lessonIds.size !== Math.min(visibleLessons.length, 500))}
                  >
                    {lessonIds.size === Math.min(visibleLessons.length, 500) ? "取消全选" : visibleLessons.length > 500 ? "选择前 500 项" : "全选课堂"}
                  </Button>
                  {visibleLessons.length ? (
                    <div className="task-option-list" role="group" aria-label="选择课堂课件">
                      {visibleLessons.map((lesson, index) => (
                        <Label
                          key={lesson.ref.lessonId}
                          className="task-option"
                          htmlFor={`task-lesson-${index}`}
                        >
                          <Checkbox
                            id={`task-lesson-${index}`}
                            aria-label={lesson.title || "未命名课堂"}
                            checked={lessonIds.has(lessonId(lesson))}
                            disabled={previewBusy || startBusy || (lessonIds.size >= 500 && !lessonIds.has(lessonId(lesson)))}
                            onCheckedChange={(value) => {
                              const id = lessonId(lesson);
                              setLessonIds((previous) => {
                                const next = new Set(previous);
                                if (value === true && next.size < 500) next.add(id);
                                if (value !== true) next.delete(id);
                                return next;
                              });
                              setError(null);
                              invalidatePreview();
                            }}
                          />
                          <span>
                            <strong>{lesson.title || "未命名课堂"}</strong>
                            <small>
                              {lesson.startsAtMs === null
                                ? "开课时间未提供"
                                : `开课 ${new Date(lesson.startsAtMs).toLocaleString("zh-CN")}`}
                              {lesson.finished === null
                                ? ""
                                : lesson.finished
                                  ? " · 已结束"
                                  : " · 未结束"}
                            </small>
                          </span>
                        </Label>
                      ))}
                    </div>
                  ) : (
                    <p className="field-help">没有读取到课堂课件。</p>
                  )}
                </>
              )}
              {lessonState === "success" && kind === "live" && (
                <div className="task-settings">
                  <div className="field">
                    <Label htmlFor="task-live-lesson">课堂</Label>
                    <Select
                      value={liveLessonId}
                      onValueChange={(value) => {
                        setLiveLessonId(value);
                        setError(null);
                        invalidatePreview();
                      }}
                      disabled={previewBusy || startBusy}
                    >
                      <SelectTrigger id="task-live-lesson">
                        <SelectValue placeholder="选择课堂" />
                      </SelectTrigger>
                      <SelectContent>
                        {visibleLessons.map((lesson) => (
                          <SelectItem key={lesson.ref.lessonId} value={lesson.ref.lessonId}>
                            {lesson.title || "未命名课堂"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="field">
                    <Label htmlFor="task-live-minutes">最长运行（分钟）</Label>
                    <Input
                      id="task-live-minutes"
                      type="number"
                      min={1}
                      max={1440}
                      step={1}
                      required
                      value={liveMaxMinutes}
                      disabled={previewBusy || startBusy}
                      onChange={(event) =>
                        changeNumber(event.target.value, setLiveMaxMinutes)
                      }
                    />
                  </div>
                </div>
              )}
            </fieldset>
          )}

          {error && <Failure message={error} />}
          {preview && (
            <section className="task-preview" aria-label="任务预览">
              <div>
                <strong>{taskLabels[preview.kind]}</strong>
                <span>
                  {preview.profileName} · {preview.courseTitle}
                </span>
              </div>
              <p>
                范围 {preview.items.length} 项 · 参数{" "}
                {preview.settings.join("、") || "无"}
              </p>
              <ul className="task-preview-list">
                {preview.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              {preview.warnings.length > 0 && (
                <Alert>
                  <CircleAlert aria-hidden="true" />
                  <AlertTitle>预览警告</AlertTitle>
                  <AlertDescription>
                    <ul>
                      {preview.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
              {preview.blockers.length > 0 && (
                <Alert variant="destructive">
                  <CircleAlert aria-hidden="true" />
                  <AlertTitle>暂时不能开始</AlertTitle>
                  <AlertDescription>
                    <ul>
                      {preview.blockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
              <p className="field-help">
                预览有效至{" "}
                {new Date(preview.expiresAtMs).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })}
                。开始前请确认范围。
              </p>
              <Button
                type="button"
                disabled={preview.blockers.length > 0 || startBusy}
                onClick={() => void start()}
              >
                <Play aria-hidden="true" />
                {startBusy ? "正在启动…" : "确认并开始任务"}
              </Button>
            </section>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={previewBusy || startBusy}
              onClick={closeDialog}
            >
              取消
            </Button>
            <ActionButton
              type="submit"
              state={previewBusy ? "loading" : error ? "error" : "idle"}
              disabled={!canCreatePreview}
              labels={{
                idle: preview ? "重新生成预览" : "生成任务预览",
                loading: "正在生成预览…",
                success: "已生成",
                error: "重试预览",
              }}
            />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
