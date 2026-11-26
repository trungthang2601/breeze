package tools

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

const testTransferID = "0f8fad5b-d9cb-469f-a165-70867728950e"

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func chunkPayload(path string, offset, total int, data []byte) map[string]any {
	return map[string]any{
		"path":       path,
		"transferId": testTransferID,
		"offset":     float64(offset),
		"totalSize":  float64(total),
		"content":    base64.StdEncoding.EncodeToString(data),
	}
}

func finalPayload(path string, offset, total int, data, whole []byte) map[string]any {
	p := chunkPayload(path, offset, total, data)
	p["final"] = true
	p["sha256"] = sha256Hex(whole)
	return p
}

func mustSucceed(t *testing.T, r CommandResult) map[string]any {
	t.Helper()
	if r.Status != "completed" {
		t.Fatalf("expected success, got status=%s error=%s", r.Status, r.Error)
	}
	out := map[string]any{}
	if err := json.Unmarshal([]byte(r.Stdout), &out); err != nil {
		t.Fatalf("result stdout is not JSON: %v (%q)", err, r.Stdout)
	}
	return out
}

func mustFail(t *testing.T, r CommandResult, contains string) {
	t.Helper()
	if r.Status == "completed" {
		t.Fatalf("expected failure containing %q, got success: %s", contains, r.Stdout)
	}
	if !strings.Contains(r.Error, contains) {
		t.Fatalf("expected error containing %q, got %q", contains, r.Error)
	}
}

func testData(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i*7 + i/251)
	}
	return b
}

func TestWriteFileChunkAssemblesVerifiesAndRenames(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "big.bin")
	whole := testData(5*1024*1024 + 123)

	// Pre-existing destination content must survive until the final rename.
	if err := os.WriteFile(dest, []byte("old"), 0644); err != nil {
		t.Fatal(err)
	}

	for off := 0; off < len(whole); off += FileChunkMaxBytes {
		end := off + FileChunkMaxBytes
		if end > len(whole) {
			end = len(whole)
		}
		var r CommandResult
		if end == len(whole) {
			r = WriteFileChunk(finalPayload(dest, off, len(whole), whole[off:end], whole))
		} else {
			r = WriteFileChunk(chunkPayload(dest, off, len(whole), whole[off:end]))
			if got, _ := os.ReadFile(dest); string(got) != "old" {
				t.Fatalf("destination changed before the final chunk")
			}
		}
		mustSucceed(t, r)
	}

	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, whole) {
		t.Fatalf("assembled file differs from source (%d vs %d bytes)", len(got), len(whole))
	}
	if _, err := os.Stat(uploadTempPath(dest, testTransferID)); !os.IsNotExist(err) {
		t.Fatalf("temp file should be gone after a successful upload, stat err=%v", err)
	}
}

func TestWriteFileChunkChecksumMismatchDiscardsAndKeepsDestination(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "a.txt")
	if err := os.WriteFile(dest, []byte("original"), 0644); err != nil {
		t.Fatal(err)
	}
	data := []byte("new content")
	p := finalPayload(dest, 0, len(data), data, []byte("something else"))
	mustFail(t, WriteFileChunk(p), "checksum mismatch")

	if got, _ := os.ReadFile(dest); string(got) != "original" {
		t.Fatalf("destination must be untouched on checksum mismatch, got %q", got)
	}
	if _, err := os.Stat(uploadTempPath(dest, testTransferID)); !os.IsNotExist(err) {
		t.Fatalf("temp file must be discarded on checksum mismatch, stat err=%v", err)
	}
}

func TestWriteFileChunkOffsetMismatchAndReplay(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "a.bin")
	whole := testData(30)

	mustSucceed(t, WriteFileChunk(chunkPayload(dest, 0, 30, whole[:10])))
	mustSucceed(t, WriteFileChunk(chunkPayload(dest, 10, 30, whole[10:20])))
	// Exact replay of the last chunk (lost reply) is acknowledged.
	out := mustSucceed(t, WriteFileChunk(chunkPayload(dest, 10, 30, whole[10:20])))
	if out["written"] != false {
		t.Fatalf("replayed chunk should report written=false, got %v", out["written"])
	}
	// A gap is refused.
	mustFail(t, WriteFileChunk(chunkPayload(dest, 25, 30, whole[25:30])), "offset mismatch")
	// A different payload at a replayed offset is refused.
	mustFail(t, WriteFileChunk(chunkPayload(dest, 10, 30, testData(10))), "offset mismatch")

	mustSucceed(t, WriteFileChunk(finalPayload(dest, 20, 30, whole[20:30], whole)))
	if got, _ := os.ReadFile(dest); !bytes.Equal(got, whole) {
		t.Fatalf("assembled file differs from source")
	}
}

func TestWriteFileChunkWithoutFirstChunkIsRefused(t *testing.T) {
	dest := filepath.Join(t.TempDir(), "a.bin")
	mustFail(t, WriteFileChunk(chunkPayload(dest, 10, 30, testData(10))), "restart the upload")
}

func TestWriteFileChunkAbortRemovesPartial(t *testing.T) {
	dest := filepath.Join(t.TempDir(), "a.bin")
	mustSucceed(t, WriteFileChunk(chunkPayload(dest, 0, 30, testData(10))))
	if _, err := os.Stat(uploadTempPath(dest, testTransferID)); err != nil {
		t.Fatalf("temp file should exist mid-upload: %v", err)
	}
	mustSucceed(t, WriteFileChunk(map[string]any{"path": dest, "transferId": testTransferID, "abort": true}))
	if _, err := os.Stat(uploadTempPath(dest, testTransferID)); !os.IsNotExist(err) {
		t.Fatalf("abort must remove the temp file, stat err=%v", err)
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatalf("abort must not create the destination, stat err=%v", err)
	}
}

func TestWriteFileChunkRejectsBadInput(t *testing.T) {
	dest := filepath.Join(t.TempDir(), "a.bin")

	p := chunkPayload(dest, 0, 10, testData(10))
	p["transferId"] = "../../x"
	mustFail(t, WriteFileChunk(p), "transferId")

	mustFail(t, WriteFileChunk(chunkPayload(dest, 0, MaxChunkedTransferSize+1, testData(10))), "too large")
	mustFail(t, WriteFileChunk(chunkPayload(dest, 0, 5, testData(10))), "exceeds totalSize")

	p = chunkPayload(dest, 0, 10, testData(10))
	p["final"] = true
	mustFail(t, WriteFileChunk(p), "sha256 is required")

	p = chunkPayload(dest, 0, FileChunkMaxBytes+1, testData(FileChunkMaxBytes+1))
	mustFail(t, WriteFileChunk(p), "too large")
}

func TestWriteFileChunkFinalOnDirectoryIsRefused(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "sub")
	if err := os.Mkdir(dest, 0755); err != nil {
		t.Fatal(err)
	}
	data := []byte("x")
	mustFail(t, WriteFileChunk(finalPayload(dest, 0, 1, data, data)), "directory")
	if _, err := os.Stat(uploadTempPath(dest, testTransferID)); !os.IsNotExist(err) {
		t.Fatalf("temp file must be cleaned up, stat err=%v", err)
	}
}

func TestWriteFileChunkEmptyFile(t *testing.T) {
	dest := filepath.Join(t.TempDir(), "empty.txt")
	mustSucceed(t, WriteFileChunk(finalPayload(dest, 0, 0, nil, nil)))
	info, err := os.Stat(dest)
	if err != nil || info.Size() != 0 {
		t.Fatalf("expected an empty destination file, info=%v err=%v", info, err)
	}
}

func TestSweepStaleUploadsRemovesOnlyOldTempFiles(t *testing.T) {
	dir := t.TempDir()
	stale := filepath.Join(dir, ".x.bin.aaaaaaaa"+uploadTempSuffix)
	fresh := filepath.Join(dir, ".y.bin.bbbbbbbb"+uploadTempSuffix)
	other := filepath.Join(dir, "keep.breeze-upload.txt")
	for _, p := range []string{stale, fresh, other} {
		if err := os.WriteFile(p, []byte("1"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-2 * staleUploadMaxAge)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(other, old, old); err != nil {
		t.Fatal(err)
	}
	sweepStaleUploads(dir)
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale temp file should be removed")
	}
	for _, p := range []string{fresh, other} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("%s should be kept: %v", p, err)
		}
	}
}

func TestReadFileChunkRoundTripWithHash(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.bin")
	whole := testData(3*FileChunkMaxBytes + 17)
	if err := os.WriteFile(src, whole, 0644); err != nil {
		t.Fatal(err)
	}

	var assembled []byte
	var wantHash string
	for off := 0; ; {
		p := map[string]any{"path": src, "offset": float64(off), "length": float64(FileChunkMaxBytes)}
		if off == 0 {
			p["withHash"] = true
		}
		out := mustSucceed(t, ReadFileChunk(p))
		if off == 0 {
			wantHash, _ = out["sha256"].(string)
		}
		if int(out["size"].(float64)) != len(whole) {
			t.Fatalf("size = %v, want %d", out["size"], len(whole))
		}
		chunk, err := base64.StdEncoding.DecodeString(out["content"].(string))
		if err != nil {
			t.Fatal(err)
		}
		assembled = append(assembled, chunk...)
		off += len(chunk)
		if out["eof"] == true {
			break
		}
		if len(chunk) == 0 {
			t.Fatal("non-eof chunk returned no data")
		}
	}
	if !bytes.Equal(assembled, whole) {
		t.Fatalf("assembled download differs from source")
	}
	if wantHash != sha256Hex(whole) {
		t.Fatalf("sha256 = %s, want %s", wantHash, sha256Hex(whole))
	}
}

func TestReadFileChunkRejectsBadInput(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.bin")
	if err := os.WriteFile(src, testData(10), 0644); err != nil {
		t.Fatal(err)
	}
	mustFail(t, ReadFileChunk(map[string]any{"path": src, "length": float64(FileChunkMaxBytes + 1)}), "length")
	mustFail(t, ReadFileChunk(map[string]any{"path": src, "offset": float64(11)}), "past the end")
	mustFail(t, ReadFileChunk(map[string]any{"path": dir}), "directory")
	mustFail(t, ReadFileChunk(map[string]any{"path": filepath.Join(dir, "missing")}), "failed to stat file")
}

// TestChunkedTransferConstantsMatchShared pins the chunked caps to the web
// mirror, like TestMaxFileReadSizeMatchesSharedConstant does for the read cap.
func TestChunkedTransferConstantsMatchShared(t *testing.T) {
	if MaxChunkedTransferSize != 100*1024*1024 || FileChunkMaxBytes != 2*1024*1024 {
		t.Fatalf("chunked caps changed (max=%d chunk=%d); update AGENT_MAX_CHUNKED_TRANSFER_BYTES / "+
			"AGENT_FILE_CHUNK_BYTES in packages/shared/src/constants/agentFileTransfer.ts in the SAME commit",
			MaxChunkedTransferSize, FileChunkMaxBytes)
	}
	data, err := os.ReadFile(filepath.Clean(sharedReadCapPath))
	if err != nil {
		t.Fatalf("cannot read the shared constants: %v", err)
	}
	for name, want := range map[string]int{
		"AGENT_MAX_CHUNKED_TRANSFER_BYTES": MaxChunkedTransferSize,
		"AGENT_FILE_CHUNK_BYTES":           FileChunkMaxBytes,
	} {
		m := regexp.MustCompile(`export\s+const\s+` + name + `\s*=\s*([0-9_*\s]+?);`).FindSubmatch(data)
		if m == nil {
			t.Fatalf("no `export const %s = <expr>;` declaration found", name)
		}
		got, err := evalByteProduct(string(m[1]))
		if err != nil {
			t.Fatalf("could not parse %s value %q: %v", name, m[1], err)
		}
		if got != want {
			t.Fatalf("shared %s = %d, Go = %d", name, got, want)
		}
	}
}

// TestFileChunkFitsFrameBudgets: a write chunk must fit the single-shot write
// cap (so the WS frame budget audited in websocket/limits_test.go still
// holds), and a read chunk must fit the server's 5,000,000-byte result cap.
func TestFileChunkFitsFrameBudgets(t *testing.T) {
	if FileChunkMaxBytes > MaxFileWriteSize {
		t.Fatalf("FileChunkMaxBytes (%d) exceeds MaxFileWriteSize (%d)", FileChunkMaxBytes, MaxFileWriteSize)
	}
	if encoded := base64.StdEncoding.EncodedLen(FileChunkMaxBytes); encoded+64*1024 >= 5000000 {
		t.Fatalf("a %d-byte read chunk encodes to %d bytes, too close to the 5,000,000-byte result cap", FileChunkMaxBytes, encoded)
	}
}
