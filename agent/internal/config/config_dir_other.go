//go:build !windows

package config

import (
	"runtime"
)

func platformConfigDir() string {
	if runtime.GOOS == "darwin" {
		return "/Library/Application Support/Breeze"
	}
	return linuxPerUserDir("/etc/breeze", "XDG_CONFIG_HOME", ".config", "")
}
