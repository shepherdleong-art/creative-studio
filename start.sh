#!/bin/bash
# 产品素材工作台 — 一键启动脚本（终端变体）。
# 单一事实来源是 start.command，本脚本只做转发，避免双份实现漂移。
exec bash "$(cd "$(dirname "$0")" && pwd -P)/start.command" "$@"
