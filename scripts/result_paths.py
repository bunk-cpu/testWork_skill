"""Allocate page or timestamped retest output paths without overwriting a run."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path
import re

WORKSPACE = Path(__file__).resolve().parents[4]
SHANGHAI = timezone(timedelta(hours=8))
CLASSIFICATION = json.loads((Path(__file__).resolve().parent.parent / 'references/page-areas.json').read_text(encoding='utf-8'))

def resolve_area(area, page=None):
    area = CLASSIFICATION['areas'].get(area, area)
    known = CLASSIFICATION['pages'].get(page)
    if area and area not in CLASSIFICATION['areas'].values(): raise ValueError('分类必须为 frontend、backend、common 或对应目录名。')
    if area and known and area != known: raise ValueError('页面所属前台/后台与指定分类不一致。')
    if not area and not known: raise ValueError('请使用 --area frontend 或 backend 指定新页面或批次的所属端；TAPD 工具验证使用 common。')
    return area or known

def component(value: str) -> str:
    if not value or value != value.strip() or re.search(r'[<>:"/\\|?*\x00-\x1f]', value) or value.endswith(('.', ' ')) or value in {'.', '..'} or re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', value, re.I):
        raise ValueError('名称必须是有效的单层 Windows 文件夹名。')
    return value

def contained(root: Path, candidate: Path) -> Path:
    result = candidate.resolve()
    if not result.is_relative_to(root.resolve()): raise ValueError('输出路径不得越过测试根目录。')
    return result

def allocate(*, root=WORKSPACE, mode, area=None, page=None, defect=None, batch=None, base=None, started_at=None):
    root = Path(root).resolve()
    if defect and not page: raise ValueError('缺陷 ID 必须同时指定页面。')
    if page:
        component(page)
        if page in {'.agents', '回测结果', '测试汇总', '通用测试资料', '资源中心前台', '资源中心后台'}: raise ValueError('页面名称不能使用工作区功能目录名。')
    if defect:
        component(defect)
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', defect): raise ValueError('缺陷 ID 格式无效。')
    if mode not in {'page', 'retest'}: raise ValueError('未知输出模式。')
    if base:
        normalized = base.replace('\\', '/')
        matches = [prefix for prefix in CLASSIFICATION['areas'].values() if normalized.startswith(prefix + '/回测结果/')]
        if len(matches) != 1: raise ValueError('批次路径应为 所属端/回测结果/日期/批次，TAPD 工具验证在通用测试资料/TAPD自动化下。')
        inherited = matches[0]
        if area and resolve_area(area, page) != inherited: raise ValueError('复用批次与所属端不一致。')
        area = resolve_area(inherited, page)
    else:
        area = resolve_area(area, page)
    area_root = contained(root, root / area)
    if mode == 'page':
        if not page or base or batch or started_at: raise ValueError('页面模式需要 --page，不能指定回测批次参数。')
        result_root = area_root
    else:
        if base:
            if batch or started_at: raise ValueError('复用批次时不再指定新批次名称或时间。')
            relative = Path(normalized)
            suffix = normalized[len(area) + 1:].split('/')
            if relative.is_absolute() or len(suffix) != 3 or suffix[0] != '回测结果': raise ValueError('批次路径应为 所属端/回测结果/日期/批次。')
            datetime.strptime(suffix[1], '%Y-%m-%d')
            component(suffix[2])
            result_root = contained(root, root / relative)
            if not result_root.is_dir(): raise ValueError('要复用的批次目录不存在。')
        else:
            if not batch: raise ValueError('新回测需要 --batch。')
            component(batch)
            start = datetime.fromisoformat(started_at) if started_at else datetime.now(SHANGHAI)
            start = start.replace(tzinfo=SHANGHAI) if start.tzinfo is None else start.astimezone(SHANGHAI)
            prefix = f'{start:%H%M%S}_{batch}'
            day = contained(root, area_root / '回测结果' / f'{start:%Y-%m-%d}')
            day.mkdir(parents=True, exist_ok=True)
            number = 1
            while True:
                result_root = contained(root, day / (prefix if number == 1 else f'{prefix}_{number:02d}'))
                try:
                    result_root.mkdir()
                    break
                except FileExistsError:
                    number += 1
            (result_root / '回测批次.json').write_text(json.dumps({'kind': 'retest', 'area': area, 'name': batch, 'startedAt': start.isoformat(), 'timezone': 'Asia/Shanghai', 'resultBase': result_root.relative_to(root).as_posix()}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    target = result_root
    if page:
        target = contained(root, result_root / page)
    if defect:
        target = contained(root, target / defect)
    target.mkdir(parents=True, exist_ok=True)
    return {'mode': mode, 'root': str(root), 'area': area, 'resultBase': result_root.relative_to(root).as_posix(), 'resultDirectory': str(result_root), 'page': page, 'defect': defect, 'outputDirectory': str(target)}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=['page', 'retest'], required=True)
    parser.add_argument('--area', help='frontend / backend / common；已有页面可自动识别')
    parser.add_argument('--page'); parser.add_argument('--defect'); parser.add_argument('--batch')
    parser.add_argument('--base'); parser.add_argument('--started-at')
    args = vars(parser.parse_args())
    try: print(json.dumps(allocate(**args), ensure_ascii=False, indent=2))
    except ValueError as error: parser.error(str(error))

if __name__ == '__main__':
    main()
