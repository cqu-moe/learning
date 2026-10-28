import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, useRevalidator } from "react-router";
import {
  ArrowRight,
  CheckCircle2,
  Plus,
  QrCode,
  Smartphone,
  UsersRound,
} from "lucide-react";
import {
  ActionButton,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  PageHeader,
  PageState,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  toast,
} from "@cqu-moe/ui";
import { PlatformSchema } from "@learning/sdk/public";
import type { Platform } from "@learning/sdk/public";
import { z } from "zod";
import { ProfileSchema, LoginStateSchema } from "../../shared/contracts.ts";
import type { Profile, LoginState } from "../../shared/contracts.ts";
import { useDashboard } from "../data.ts";
import { api, errorMessage } from "../api.ts";
import { Failure, platforms } from "../components.tsx";

function AddAccount() {
  const { revalidate } = useRevalidator();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [platform, setPlatform] = useState<Platform>("ykt");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const valid =
      name.trim().length > 0 &&
      name === name.trim() &&
      name.length <= 128 &&
      ![...name].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      );
    if (!valid) {
      setFieldError("填写 1–128 个字符的名称，开头和结尾不要留空格。");
      input.current?.focus();
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    setFieldError(null);
    try {
      await api("/profiles", ProfileSchema, {
        method: "POST",
        body: JSON.stringify({ name, platform }),
      });
      setOpen(false);
      setName("");
      toast.success("账号已添加，接下来扫码登录。");
      void revalidate().catch(() =>
        toast.error("账号已添加，但列表刷新失败。请刷新页面。"),
      );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!submitting.current) {
          setOpen(value);
          setError(null);
          setFieldError(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus aria-hidden="true" />
          添加账号
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加平台账号</DialogTitle>
          <DialogDescription>
            先选择平台并设置名称，再用手机扫码登录。
          </DialogDescription>
        </DialogHeader>
        <form className="account-form" onSubmit={(event) => void submit(event)}>
          <div className="field">
            <Label htmlFor="account-platform">学习平台</Label>
            <Select
              value={platform}
              onValueChange={(value) =>
                setPlatform(PlatformSchema.parse(value))
              }
              disabled={busy}
            >
              <SelectTrigger id="account-platform">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(platforms).map(([key, label]) => (
                  <SelectItem key={key} value={key}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="field">
            <Label htmlFor="account-name">账号名称</Label>
            <Input
              ref={input}
              id="account-name"
              value={name}
              maxLength={128}
              disabled={busy}
              autoComplete="off"
              placeholder="例如：我的雨课堂"
              aria-invalid={fieldError !== null}
              aria-describedby={
                fieldError ? "account-name-error" : "account-name-help"
              }
              onChange={(event) => {
                setName(event.target.value);
                if (fieldError) setFieldError(null);
                setError(null);
              }}
            />
            <p
              id={fieldError ? "account-name-error" : "account-name-help"}
              className={fieldError ? "field-error" : "field-help"}
            >
              {fieldError ?? "名称只用于本机区分账号，可以使用你熟悉的称呼。"}
            </p>
          </div>
          {error && <Failure message={error} />}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <ActionButton
              type="submit"
              state={busy ? "loading" : error ? "error" : "idle"}
              labels={{
                idle: "添加账号",
                loading: "正在添加…",
                success: "已添加",
                error: "重试添加",
              }}
            />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const loginLabels = {
  waiting: "用手机扫描二维码",
  scanned: "已扫码，在手机上确认",
  exchanging: "正在完成登录",
  authenticated: "登录完成",
  failed: "登录未完成",
  canceled: "登录已取消",
};
const terminal = ["authenticated", "failed", "canceled"];

function AccountCard({ profile }: { profile: Profile }) {
  const { revalidate } = useRevalidator();
  const [open, setOpen] = useState(false);
  const [login, setLogin] = useState<LoginState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeId = useRef<string | null>(null);
  const mounted = useRef(true);
  const startController = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      mounted.current = false;
      startController.current?.abort();
      if (activeId.current)
        void api(
          `/logins/${encodeURIComponent(activeId.current)}`,
          z.unknown(),
          { method: "DELETE", body: "{}", keepalive: true },
        ).catch(() => undefined);
    },
    [],
  );
  useEffect(() => {
    if (!open || !login || terminal.includes(login.status)) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const current = await api(
          `/logins/${encodeURIComponent(login!.id)}`,
          LoginStateSchema,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setLogin(current);
        setError(null);
        if (current.status === "authenticated") {
          activeId.current = null;
          void revalidate().catch(() =>
            toast.error("登录成功，但账号列表刷新失败。请刷新页面。"),
          );
        }
        if (!terminal.includes(current.status))
          timer = setTimeout(() => void poll(), 1500);
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(errorMessage(failure));
          timer = setTimeout(() => void poll(), 3000);
        }
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, login?.id, login?.status, revalidate]);
  async function start() {
    if (startController.current) return;
    const controller = new AbortController();
    startController.current = controller;
    setBusy(true);
    setError(null);
    setLogin(null);
    try {
      if (activeId.current)
        await api(
          `/logins/${encodeURIComponent(activeId.current)}`,
          z.unknown(),
          { method: "DELETE", body: "{}", signal: controller.signal },
        );
      activeId.current = null;
      const result = await api(
        `/profiles/${encodeURIComponent(profile.scope.profileId)}/login`,
        z.object({ id: z.string() }),
        { method: "POST", body: "{}", signal: controller.signal },
      );
      if (!mounted.current || controller.signal.aborted) {
        await api(`/logins/${encodeURIComponent(result.id)}`, z.unknown(), {
          method: "DELETE",
          body: "{}",
          keepalive: true,
        });
        return;
      }
      activeId.current = result.id;
      setLogin({ id: result.id, status: "waiting", qr: null, message: null });
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted)
        setError(errorMessage(failure));
    } finally {
      if (startController.current === controller) {
        startController.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }
  function close() {
    startController.current?.abort();
    startController.current = null;
    const id = activeId.current;
    activeId.current = null;
    setOpen(false);
    setBusy(false);
    setLogin(null);
    setError(null);
    if (id)
      void api(`/logins/${encodeURIComponent(id)}`, z.unknown(), {
        method: "DELETE",
        body: "{}",
        keepalive: true,
      }).catch(() =>
        toast.error(
          "窗口已关闭，但取消登录未得到确认。请等待二维码过期后重试。",
        ),
      );
  }
  return (
    <article className="surface account-card">
      <div className="account-card-heading">
        <UsersRound size={20} aria-hidden="true" />
        <span>{platforms[profile.scope.platform]}</span>
      </div>
      <h2>{profile.name}</h2>
      <p className="account-session">
        {profile.hasSession ? (
          <CheckCircle2 size={16} aria-hidden="true" />
        ) : (
          <QrCode size={16} aria-hidden="true" />
        )}
        {profile.hasSession ? "本机已有登录记录" : "尚未登录"}
      </p>
      <p className="muted small">
        {profile.hasSession
          ? "记录可能已过期，读取课程时会核验登录状态。"
          : "扫码后即可获取这个账号的课程。"}
      </p>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (value) {
            setOpen(true);
            setError(null);
          } else void close();
        }}
      >
        <DialogTrigger asChild>
          <Button variant="outline">
            <QrCode aria-hidden="true" />
            {profile.hasSession ? "重新扫码登录" : "扫码登录"}
          </Button>
        </DialogTrigger>
        <DialogContent className="login-dialog">
          <DialogHeader>
            <DialogTitle>登录{platforms[profile.scope.platform]}</DialogTitle>
            <DialogDescription>
              {profile.name} · 在手机上完成平台登录验证。
            </DialogDescription>
          </DialogHeader>
          {error && <Failure message={error} />}
          {!login && !busy && (
            <div className="login-intro">
              <Smartphone size={32} aria-hidden="true" />
              <p>准备好手机后，获取登录二维码。</p>
              <ActionButton
                state={error ? "error" : "idle"}
                labels={{
                  idle: "获取二维码",
                  loading: "正在获取…",
                  success: "已获取",
                  error: "重新获取",
                }}
                onClick={() => void start()}
              />
            </div>
          )}
          {busy && (
            <PageState
              state="loading"
              title="正在获取二维码"
              description="正在联系学习平台，请稍候。"
            />
          )}
          {login && (
            <div className="qr-state" aria-live="polite">
              {login.status === "authenticated" ? (
                <CheckCircle2 size={32} aria-hidden="true" />
              ) : login.qr?.imageDataUrl ? (
                <img
                  src={login.qr.imageDataUrl}
                  width={224}
                  height={224}
                  alt={`${platforms[profile.scope.platform]}登录二维码`}
                />
              ) : !terminal.includes(login.status) ? (
                <PageState
                  state="loading"
                  title="二维码正在准备中"
                  description="请稍候。"
                />
              ) : (
                <QrCode size={32} aria-hidden="true" />
              )}
              <h3>{loginLabels[login.status]}</h3>
              {login.message && <p>{login.message}</p>}
              {login.qr && !terminal.includes(login.status) && (
                <p className="muted small">
                  二维码有效至{" "}
                  {new Date(login.qr.expiresAtMs).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                    hour12: false,
                  })}
                  ，请及时扫码。
                </p>
              )}
              {["failed", "canceled"].includes(login.status) && (
                <Button variant="outline" onClick={() => void start()}>
                  重新获取二维码
                </Button>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => void close()}>
              {login?.status === "authenticated" ? "完成" : "取消登录"}
            </Button>
            {login?.status === "authenticated" && (
              <Button asChild>
                <Link to="/courses">
                  去获取课程
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  );
}

export function Accounts() {
  const data = useDashboard();
  return (
    <>
      <PageHeader
        title="平台账号"
        description="连接常用的学习平台，让课程集中在这里。"
        actions={<AddAccount />}
      />
      {data.profiles.length ? (
        <div className="account-grid">
          {data.profiles.map((profile) => (
            <AccountCard key={profile.scope.profileId} profile={profile} />
          ))}
        </div>
      ) : (
        <div className="surface">
          <PageState
            state="empty"
            title="添加你的第一个平台账号"
            description="支持雨课堂、学堂在线和智慧树。点击右上方「添加账号」，开始连接。"
          />
        </div>
      )}
      <p className="page-note">
        账号与登录信息保存在本机，与 Learning
        命令行共用。首次登录或会话过期时，需要在手机上完成验证。
      </p>
    </>
  );
}
