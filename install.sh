#!/usr/bin/env bash
set -euo pipefail
adapter="${DSH_ADAPTER_ROOT:-$HOME/CODE/dsh-std}"
exec bash "$adapter/scripts/install-personal-plugins.sh"
