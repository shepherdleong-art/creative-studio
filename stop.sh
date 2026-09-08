#!/bin/bash
# 产品素材工作台 — 关闭服务脚本（终端变体）。
# 单一事实来源是 stop.command，本脚本只做转发，避免双份实现漂移。
exec bash "$(cd "$(dirname "$0")" && pwd -P)/stop.command" "$@"
