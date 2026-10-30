"""Executed over authenticated SSH. All paths and actions arrive as JSON on stdin."""
import contextlib
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import time

def is_link(file):
    return os.path.islink(file) or getattr(os.path, "isjunction", lambda value: False)(file)


def remove_tree(base, directory):
    base, directory = os.path.abspath(base), os.path.abspath(directory)
    if directory == base or os.path.commonpath([base, directory]) != base or is_link(directory):
        raise ValueError("拒绝清理事务目录之外的路径")
    shutil.rmtree(directory)


def read_json(file, default=None):
    try:
        with open(file, encoding="utf-8") as stream:
            return json.load(stream)
    except FileNotFoundError:
        return default


def save(file, value):
    temporary = file + ".tmp"
    with open(temporary, "w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, file)


def safe(base, name):
    if not isinstance(name, str) or not name or "\\" in name or re.search(r"[\x00-\x1f:]", name):
        raise ValueError("文件路径不合法")
    parts = name.split("/")
    if any(part in ("", ".", "..") for part in parts) or parts[0].startswith("."):
        raise ValueError("拒绝访问网站配置或目录外文件")
    target = os.path.join(base, *parts)
    current = base
    for part in parts:
        current = os.path.join(current, part)
        if is_link(current):
            raise ValueError("网站文件路径不能经过符号链接：" + name)
    if os.path.commonpath([base, os.path.abspath(target)]) != base:
        raise ValueError("文件超出网站目录")
    return target


def site_path(root, name):
    """The reserved transfer namespace always maps OUTSIDE the public web root."""
    prefix = "_portfolio_private/"
    if not name.startswith(prefix):
        return safe(root, name)
    private_parent = os.path.join(os.path.dirname(root), ".portfolio-spaces")
    private = os.path.join(private_parent, hashlib.sha256(root.encode()).hexdigest()[:20])
    for directory in (private_parent, private):
        if is_link(directory):
            raise ValueError("私密目录不能经过符号链接")
        os.makedirs(directory, mode=0o750, exist_ok=True)
    return safe(private, name[len(prefix):])


def private_permissions(root, name, target):
    if not name.startswith("_portfolio_private/"):
        os.chmod(target, 0o644)
        return
    # The BaoTa worker account can read the runtime; it cannot modify published files.
    if os.name != "nt" and os.geteuid() == 0:
        import grp
        try:
            group = grp.getgrnam("www").gr_gid
        except KeyError:
            # Public-only installations need not have a BaoTa account yet.
            # The setup guide requires an administrator to provision read access.
            os.chmod(target, 0o640)
            return
        private_parent = os.path.join(os.path.dirname(root), ".portfolio-spaces")
        current = os.path.dirname(target)
        while os.path.commonpath([private_parent, current]) == private_parent:
            os.chown(current, -1, group)
            os.chmod(current, 0o750)
            if current == private_parent:
                break
            current = os.path.dirname(current)
        os.chown(target, -1, group)
    os.chmod(target, 0o640)


def file_hash(file):
    if not os.path.lexists(file):
        return None
    if not stat.S_ISREG(os.lstat(file).st_mode):
        raise ValueError("目标路径不是普通文件")
    digest = hashlib.sha256()
    with open(file, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def manifest(value, root):
    if not isinstance(value, dict) or not value or len(value) > 65535 or "index.html" not in value:
        raise ValueError("网站清单不完整")
    for name, entry in value.items():
        site_path(root, name)
        if not isinstance(entry, dict) or not re.fullmatch(r"[a-f0-9]{64}", str(entry.get("hash", ""))) or type(entry.get("size")) is not int or entry["size"] < 0:
            raise ValueError("网站清单格式不正确")
    return value


@contextlib.contextmanager
def locked(meta):
    with open(os.path.join(meta, "lock"), "a+b") as stream:
        if os.name == "nt":  # Also allows protocol tests on a Windows workstation.
            import msvcrt
            stream.write(b"0")
            stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            if os.name == "nt":
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


def plan(root, meta, files):
    files = manifest(files, root)
    previous = read_json(os.path.join(meta, "manifest.json"), {"files": {}})
    old = previous.get("files", {})
    observed, changed, deleted, preserved = {}, [], [], []
    for name, entry in files.items():
        observed[name] = file_hash(site_path(root, name))
        if observed[name] != entry["hash"]:
            changed.append(name)
    for name, entry in old.items():
        if name in files:
            continue
        observed[name] = file_hash(site_path(root, name))
        if observed[name] == entry["hash"]:
            deleted.append(name)
        elif observed[name] is not None:
            preserved.append(name)
    fingerprint = hashlib.sha256(json.dumps([files, previous, observed], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    ready = False
    if any(name.startswith("_portfolio_private/") for name in files):
        try:
            import urllib.request
            request = urllib.request.Request("http://127.0.0.1:4181/__portfolio_space_health", headers={"X-Portfolio-Health": "1"})
            with urllib.request.urlopen(request, timeout=1) as response:
                health = json.loads(response.read(1024))
                ready = health.get("format") == "portfolio-space-gateway" and health.get("site") == hashlib.sha256(root.encode()).hexdigest()[:20]
        except Exception:
            pass
    return {"hash": fingerprint, "changed": changed, "deleted": deleted, "preserved": preserved, "privateServiceReady": ready,
            "unchanged": len(files) - len(changed), "uploadBytes": sum(files[name]["size"] for name in changed), "firstSync": not bool(old)}


def job_path(meta, token):
    if not isinstance(token, str) or not re.fullmatch(r"[a-f0-9-]{36}", token):
        raise ValueError("部署任务标识不正确")
    result = os.path.join(meta, "jobs", token)
    if is_link(result):
        raise ValueError("任务目录不能是符号链接")
    return result


def success_result(expected, cleanup_pending=False):
    return {"status": "done", "uploaded": len(expected["changed"]), "deleted": len(expected["deleted"]), "unchanged": expected["unchanged"], "uploadBytes": expected["uploadBytes"], "preserved": expected["preserved"], "cleanupPending": cleanup_pending}


def rollback(root, job, journal):
    for entry in reversed(journal["operations"]):
        target = site_path(root, entry["name"])
        backup = safe(os.path.join(job, "backup"), entry["name"])
        if os.path.isfile(backup):
            os.makedirs(os.path.dirname(target), exist_ok=True)
            os.replace(backup, target)
        elif not entry["existed"] and file_hash(target) == entry.get("newHash"):
            os.unlink(target)


def recover(root, meta):
    jobs = os.path.join(meta, "jobs")
    os.makedirs(jobs, mode=0o700, exist_ok=True)
    current = read_json(os.path.join(meta, "manifest.json"), {})
    for token in os.listdir(jobs):
        job = job_path(meta, token)
        info = read_json(os.path.join(job, "request.json"))
        journal = read_json(os.path.join(job, "journal.json"))
        if journal and journal["phase"] == "applying":
            if current.get("transaction") != token:
                rollback(root, job, journal)
                journal["phase"] = "rolled-back"
            else:
                journal["phase"] = "committed"
            save(os.path.join(job, "journal.json"), journal)
        if journal and journal["phase"] in ("committed", "rolled-back"):
            cleanup_pending = False
            for folder in ("backup", "upload"):
                directory = os.path.join(job, folder)
                if os.path.isdir(directory) and not is_link(directory):
                    try:
                        remove_tree(job, directory)
                    except OSError:
                        cleanup_pending = True
            if journal["phase"] == "committed" and info:
                save(os.path.join(job, "result.json"), success_result(info["plan"], cleanup_pending))
        # Abandoned uploads never touched the site; remove them after a day.
        if info and time.time() - info["createdAt"] > 86400 and (not journal or journal["phase"] != "applying"):
            try:
                remove_tree(meta, job)
            except OSError:
                pass


def execute(request):
    root = os.path.abspath(request["root"])
    if not os.path.isabs(request["root"]) or root != os.path.realpath(root) or not os.path.isdir(root) or root in (os.path.abspath(os.sep), "/www", "/www/wwwroot", "/home", "/var", "/var/www", "/usr", "/etc"):
        raise ValueError("请选择实际存在的网站专用目录，不能使用系统目录、父目录或符号链接")
    parent = os.path.join(os.path.dirname(root), ".portfolio-admin-sync")
    meta = os.path.join(parent, hashlib.sha256(root.encode()).hexdigest()[:20])
    for directory in (parent, meta):
        if is_link(directory):
            raise ValueError("部署记录目录不能经过符号链接")
        os.makedirs(directory, mode=0o700, exist_ok=True)
    with locked(meta):
        recover(root, meta)
        action = request["action"]
        if action == "plan":
            return plan(root, meta, request["files"])
        job = job_path(meta, request["token"])
        if action == "begin":
            current = plan(root, meta, request["files"])
            if current["hash"] != request["planHash"]:
                raise ValueError("服务器文件已变化，请重新检查差异")
            os.makedirs(job, mode=0o700, exist_ok=False)
            save(os.path.join(job, "request.json"), {"files": request["files"], "plan": current, "createdAt": time.time()})
            for name in current["changed"]:
                os.makedirs(os.path.dirname(safe(os.path.join(job, "upload"), name)), mode=0o700, exist_ok=True)
            return {"uploadDirectory": os.path.join(job, "upload")}
        info = read_json(os.path.join(job, "request.json"))
        if not info:
            raise ValueError("部署任务不存在或已清理")
        if action == "status":
            return read_json(os.path.join(job, "result.json"), {"status": "pending"})
        if action == "abort":
            journal = read_json(os.path.join(job, "journal.json"))
            if journal and journal["phase"] == "applying":
                raise ValueError("任务需要先恢复，不能直接删除")
            remove_tree(meta, job)
            return {"ok": True}
        if action != "apply":
            raise ValueError("未知部署操作")
        result = read_json(os.path.join(job, "result.json"))
        if result:
            return result
        files, expected = info["files"], info["plan"]
        if plan(root, meta, files)["hash"] != expected["hash"]:
            raise ValueError("服务器文件已变化，请重新检查差异")
        old_files = read_json(os.path.join(meta, "manifest.json"), {"files": {}})["files"]
        for name in expected["changed"]:
            staged = safe(os.path.join(job, "upload"), name)
            if file_hash(staged) != files[name]["hash"] or os.path.getsize(staged) != files[name]["size"]:
                raise ValueError("上传文件校验失败，网站未变更：" + name)
        journal = {"phase": "applying", "operations": []}
        journal_file = os.path.join(job, "journal.json")
        save(journal_file, journal)
        try:
            # New media first, data next, HTML entries last. Deletion follows verification.
            names = sorted(expected["changed"], key=lambda name: (name == "_portfolio_private/catalog.json", name == "index.html", name.endswith(".html"), name.startswith("data/"), name))
            for name in names:
                target, staged = site_path(root, name), safe(os.path.join(job, "upload"), name)
                backup = safe(os.path.join(job, "backup"), name)
                journal["operations"].append({"name": name, "existed": os.path.isfile(target), "newHash": files[name]["hash"]})
                save(journal_file, journal)
                directory = os.path.dirname(root) if name.startswith("_portfolio_private/") else root
                relative = os.path.relpath(os.path.dirname(target), directory)
                for part in relative.split(os.sep):
                    if part == ".":
                        continue
                    directory = os.path.join(directory, part)
                    if not os.path.exists(directory):
                        os.mkdir(directory, mode=0o755)
                        os.chmod(directory, 0o755)
                if os.path.isfile(target):
                    os.makedirs(os.path.dirname(backup), mode=0o700, exist_ok=True)
                    os.replace(target, backup)
                os.replace(staged, target)
                private_permissions(root, name, target)
            for name, entry in files.items():
                if file_hash(site_path(root, name)) != entry["hash"]:
                    raise ValueError("网站文件校验失败：" + name)
            for name in expected["deleted"]:
                target, backup = site_path(root, name), safe(os.path.join(job, "backup"), name)
                if file_hash(target) != old_files[name]["hash"]:
                    raise ValueError("待清理文件已被外部修改，请重新检查差异")
                journal["operations"].append({"name": name, "existed": True})
                save(journal_file, journal)
                os.makedirs(os.path.dirname(backup), mode=0o700, exist_ok=True)
                os.replace(target, backup)
            save(os.path.join(meta, "manifest.json"), {"version": 1, "transaction": request["token"], "files": files})
        except BaseException:
            # A crash after the atomic manifest replacement means the update committed.
            committed = read_json(os.path.join(meta, "manifest.json"), {}).get("transaction") == request["token"]
            if not committed:
                rollback(root, job, journal)
                journal["phase"] = "rolled-back"
                save(journal_file, journal)
                raise
        journal["phase"] = "committed"
        save(journal_file, journal)
        cleanup_pending = False
        try:
            for folder in ("backup", "upload"):
                directory = os.path.join(job, folder)
                if os.path.isdir(directory):
                    remove_tree(job, directory)
            for name in expected["deleted"]:
                directory = os.path.dirname(site_path(root, name))
                boundary = os.path.join(os.path.dirname(root), ".portfolio-spaces") if name.startswith("_portfolio_private/") else root
                while directory != boundary:
                    try:
                        os.rmdir(directory)
                    except OSError:
                        break
                    directory = os.path.dirname(directory)
        except OSError:
            cleanup_pending = True
        result = success_result(expected, cleanup_pending)
        save(os.path.join(job, "result.json"), result)
        return result


if __name__ == "__main__":
    try:
        print(json.dumps({"ok": True, "result": execute(json.load(sys.stdin))}, ensure_ascii=False))
    except BaseException as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        sys.exit(1)
