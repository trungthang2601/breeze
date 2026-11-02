package collectors

import (
	"bytes"
	"encoding/json"
	"strings"
)

// gpuNameList is the GPU-name field of the batched WMI query. It exists to
// tolerate both shapes Windows can emit: a JSON array ("GPUNames":["a","b"])
// and — critically — a bare scalar string. Windows PowerShell 5.1 (the default
// shell on essentially every managed endpoint) collapses a single-element array
// to a scalar during ConvertTo-Json, so a one-GPU host (the common case) emits
// "GPUNames":"Intel UHD" rather than ["Intel UHD"]. Decoding straight into a
// []string would fail on those hosts and, because the caller treats any parse
// error as fatal, would drop the entire hardware record (serial, model, …).
type gpuNameList []string

// UnmarshalJSON accepts a JSON array, a bare string, or null/empty.
func (g *gpuNameList) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		*g = nil
		return nil
	}
	if trimmed[0] == '[' {
		var many []string
		if err := json.Unmarshal(trimmed, &many); err != nil {
			return err
		}
		*g = many
		return nil
	}
	var one string
	if err := json.Unmarshal(trimmed, &one); err != nil {
		return err
	}
	*g = []string{one}
	return nil
}

// windowsHardwareJSON is the shape emitted by the batched WMI PowerShell query
// in collectPlatformHardware. It lives in a build-tag-free file so the parser
// and its tests can run cross-platform (darwin/linux CI).
type windowsHardwareJSON struct {
	BiosSerial        string           `json:"BiosSerial"`
	BiosVersion       string           `json:"BiosVersion"`
	BoardSerial       string           `json:"BoardSerial"`
	BoardManufacturer string           `json:"BoardManufacturer"`
	BoardProduct      string           `json:"BoardProduct"`
	BoardVersion      string           `json:"BoardVersion"`
	SysManufacturer   string           `json:"SysManufacturer"`
	SysModel          string           `json:"SysModel"`
	GPUNames          gpuNameList      `json:"GPUNames"`
	MemoryModules     memoryModuleList `json:"MemoryModules"`
}

// wmiMemoryModule is one Win32_PhysicalMemory row as the batched query emits it.
// Capacity is in bytes; Speed is the configured clock (falls back to the rated
// speed in the script) and may be 0/null when firmware does not report it.
type wmiMemoryModule struct {
	Slot         string  `json:"Slot"`
	Capacity     float64 `json:"Capacity"`
	Speed        float64 `json:"Speed"`
	Manufacturer string  `json:"Manufacturer"`
	PartNumber   string  `json:"PartNumber"`
	SerialNumber string  `json:"SerialNumber"`
}

// memoryModuleList tolerates the same PowerShell 5.1 array-collapse as
// gpuNameList: a one-stick host emits "MemoryModules":{...} instead of [{...}].
type memoryModuleList []wmiMemoryModule

// UnmarshalJSON accepts a JSON array, a bare object, or null/empty.
func (m *memoryModuleList) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		*m = nil
		return nil
	}
	if trimmed[0] == '[' {
		var many []wmiMemoryModule
		if err := json.Unmarshal(trimmed, &many); err != nil {
			return err
		}
		*m = many
		return nil
	}
	var one wmiMemoryModule
	if err := json.Unmarshal(trimmed, &one); err != nil {
		return err
	}
	*m = []wmiMemoryModule{one}
	return nil
}

// maxMemoryModules caps the list sent to the server (real boards top out at 8-16 slots).
const maxMemoryModules = 32

// toMemoryModules converts the WMI rows into the payload shape: drops empty
// slots (capacity 0), converts bytes to MB, and blanks vendor placeholders
// ("Unknown", "Undefined", "0000", ...).
func toMemoryModules(rows []wmiMemoryModule) []MemoryModule {
	out := make([]MemoryModule, 0, len(rows))
	for _, r := range rows {
		if r.Capacity <= 0 {
			continue
		}
		mod := MemoryModule{
			Slot:         truncateCollectorString(strings.TrimSpace(r.Slot)),
			CapacityMB:   uint64(r.Capacity) / (1024 * 1024),
			Manufacturer: cleanMemoryVendorValue(r.Manufacturer),
			PartNumber:   cleanMemoryVendorValue(r.PartNumber),
			SerialNumber: cleanMemoryVendorValue(r.SerialNumber),
		}
		if mod.CapacityMB == 0 {
			continue
		}
		if r.Speed > 0 && r.Speed < 100000 {
			mod.SpeedMHz = uint32(r.Speed)
		}
		out = append(out, mod)
		if len(out) == maxMemoryModules {
			break
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// cleanMemoryVendorValue trims and drops the placeholders SPD/SMBIOS report
// for unbranded or unreadable modules.
func cleanMemoryVendorValue(value string) string {
	value = cleanHardwareIdentityValue(value)
	switch strings.ToLower(value) {
	case "undefined", "0000", "00000000", "ffffffff", "manufacturer00", "modulepartnumber00", "partnum0", "serialnum0", "sernum0":
		return ""
	}
	return truncateCollectorString(value)
}

// parseHardwareJSON decodes the JSON output from the batched WMI query.
// Unknown fields are ignored; missing or null fields leave the zero value.
func parseHardwareJSON(data []byte) (windowsHardwareJSON, error) {
	var result windowsHardwareJSON
	if err := json.Unmarshal(data, &result); err != nil {
		return result, err
	}
	return result, nil
}
