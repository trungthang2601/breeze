package tools

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/wire"
)

// Chunked file transfer (file_write_chunk / file_read_chunk).
//
// The single-shot file_write / file_read commands carry a whole file inside one
// WebSocket frame / one command result, which caps them at 4MB / 1MB (see
// MaxFileWriteSize and maxFileReadSize). These two commands move a file in
// FileChunkMaxBytes pieces instead, so the transfer size is bounded only by
// MaxChunkedTransferSize while every frame stays far below the WS read limit
// (websocket.maxMessageSize) and the API's MAX_COMMAND_RESULT_BYTES.
//
// Upload protocol (stateless on the agent — all state lives in the temp file):
//   - Chunks are appended IN ORDER to "<dir>/.<name>.<transferId>.breeze-upload",
//     next to the destination so the final rename stays on one volume.
//   - Each chunk names its byte offset. A chunk whose offset is not the temp
//     file's current size is refused, except an exact replay of the previous
//     chunk (a retry after a lost reply), which is acknowledged idempotently.
//   - The final chunk carries the SHA-256 of the whole file. The agent hashes
//     the temp file, and only on a match renames it over the destination; on a
//     mismatch the temp file is deleted. The destination therefore either holds
//     the complete, verified file or is left untouched.
//   - `abort: true` deletes the temp file. Temp files older than
//     staleUploadMaxAge in the same directory are swept when a new upload starts.
//
// Download protocol: each call reads [offset, offset+length) of the file and
// reports the file's current size and mtime; `withHash: true` adds the SHA-256
// of the whole file. The caller compares size/mtime across chunks and the
// hash at the end, so a file that changes mid-transfer is detected rather than
// saved as a corrupt mix.
//
// The constants are mirrored in packages/shared/src/constants/agentFileTransfer.ts
// (AGENT_MAX_CHUNKED_TRANSFER_BYTES / AGENT_FILE_CHUNK_BYTES); fileops_chunked_test.go
// pins both directions.
const (
	// MaxChunkedTransferSize is the largest file either chunked command moves.
	MaxChunkedTransferSize = 100 * 1024 * 1024
	// FileChunkMaxBytes is the largest decoded chunk in either direction.
	// 2MB decoded is ~2.8MB base64: half of MaxFileWriteSize on the way in,
	// and well inside the API's 5,000,000-byte result cap on the way out.
	FileChunkMaxBytes = 2 * 1024 * 1024

	uploadTempSuffix  = ".breeze-upload"
	staleUploadMaxAge = 24 * time.Hour
)

var transferIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{8,64}$`)

// uploadTempPath is the in-progress file for transferID beside cleanPath.
func uploadTempPath(cleanPath, transferID string) string {
	return filepath.Join(filepath.Dir(cleanPath), "."+filepath.Base(cleanPath)+"."+transferID+uploadTempSuffix)
}

// sweepStaleUploads removes abandoned temp files (a closed browser tab never
// sends abort). Best effort: failures are ignored.
func sweepStaleUploads(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-staleUploadMaxAge)
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasPrefix(name, ".") || !strings.HasSuffix(name, uploadTempSuffix) {
			continue
		}
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() || info.ModTime().After(cutoff) {
			continue
		}
		_ = os.Remove(filepath.Join(dir, name))
	}
}

func hashFile(f *os.File) (string, error) {
	h := sha256.New()
	if _, err := io.Copy(h, io.NewSectionReader(f, 0, 1<<62)); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// WriteFileChunk handles file_write_chunk.
func WriteFileChunk(payload map[string]any) CommandResult {
	start := time.Now()
	fail := func(err error) CommandResult { return NewErrorResult(err, time.Since(start).Milliseconds()) }

	path := GetPayloadString(payload, "path", "")
	if path == "" {
		return fail(errorCodef(wire.ErrCodeInvalidArgument, "path is required"))
	}
	transferID := GetPayloadString(payload, "transferId", "")
	if !transferIDPattern.MatchString(transferID) {
		return fail(errorCodef(wire.ErrCodeInvalidArgument, "transferId is required (8-64 characters of A-Z, a-z, 0-9, -)"))
	}

	cleanPath := filepath.Clean(path)
	if isDeniedSystemPath(cleanPath) {
		return fail(errorCodef(wire.ErrCodeSystemPathDenied, "operation denied on system path: %s", cleanPath))
	}
	// Same gate as WriteFile (#3397), applied to the destination AND to the
	// temp file, which is itself a write primitive.
	if err := enforceWriteContainment(cleanPath); err != nil {
		return fail(err)
	}
	tempPath := uploadTempPath(cleanPath, transferID)
	if err := enforceWriteContainment(tempPath); err != nil {
		return fail(err)
	}

	if GetPayloadBool(payload, "abort", false) {
		if err := os.Remove(tempPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fail(fmt.Errorf("failed to remove partial upload: %w", err))
		}
		return NewSuccessResult(map[string]any{"path": cleanPath, "aborted": true}, time.Since(start).Milliseconds())
	}

	offset, err := ParsePayloadInt(payload, "offset", -1)
	if err != nil || offset < 0 {
		return fail(errorCodef(wire.ErrCodeInvalidArgument, "offset is required and must be >= 0"))
	}
	totalSize, err := ParsePayloadInt(payload, "totalSize", -1)
	if err != nil || totalSize < 0 {
		return fail(errorCodef(wire.ErrCodeInvalidArgument, "totalSize is required and must be >= 0"))
	}
	if totalSize > MaxChunkedTransferSize {
		return fail(errorCodef(wire.ErrCodePayloadTooLarge, "file write payload too large: %d bytes (max %d bytes)", totalSize, MaxChunkedTransferSize))
	}

	content := GetPayloadString(payload, "content", "")
	if len(content) > base64.StdEncoding.EncodedLen(FileChunkMaxBytes) {
		return fail(errorCodef(wire.ErrCodePayloadTooLarge, "file write payload too large (max %d bytes decoded per chunk)", FileChunkMaxBytes))
	}
	data, err := base64.StdEncoding.DecodeString(content)
	if err != nil {
		return fail(fmt.Errorf("failed to decode base64 content: %w", err))
	}
	if len(data) > FileChunkMaxBytes {
		return fail(errorCodef(wire.ErrCodePayloadTooLarge, "file write payload too large: %d bytes (max %d bytes per chunk)", len(data), FileChunkMaxBytes))
	}
	end := offset + len(data)
	if end > totalSize {
		return fail(errorCodef(wire.ErrCodeInvalidArgument, "chunk exceeds totalSize: offset %d + %d bytes > %d", offset, len(data), totalSize))
	}

	final := GetPayloadBool(payload, "final", false)
	wantHash := strings.ToLower(GetPayloadString(payload, "sha256", ""))
	if final {
		if end != totalSize {
			return fail(errorCodef(wire.ErrCodeInvalidArgument, "final chunk ends at %d, expected totalSize %d", end, totalSize))
		}
		if len(wantHash) != 64 {
			return fail(errorCodef(wire.ErrCodeInvalidArgument, "sha256 is required on the final chunk"))
		}
		if _, herr := hex.DecodeString(wantHash); herr != nil {
			return fail(errorCodef(wire.ErrCodeInvalidArgument, "sha256 must be 64 hex characters"))
		}
	}

	afterPathCheck(tempPath)
	var f *os.File
	if offset == 0 {
		parentDir := filepath.Dir(cleanPath)
		if err := os.MkdirAll(parentDir, 0755); err != nil {
			return fail(fmt.Errorf("failed to create parent directory: %w", err))
		}
		sweepStaleUploads(parentDir)
		// Truncates a temp file left by a retried first chunk; creates it
		// exclusively (refusing a planted link) otherwise.
		f, err = openForWriteChecked("write", tempPath, 0644)
	} else {
		// O_RDWR: writeChunkAt reads back a replayed chunk to compare it.
		f, err = os.OpenFile(tempPath, os.O_RDWR, 0)
		if err == nil {
			if cerr := checkOpenedForContainment("write", tempPath, f); cerr != nil {
				_ = f.Close()
				return fail(cerr)
			}
		} else if errors.Is(err, fs.ErrNotExist) {
			return fail(errorCodef(wire.ErrCodeInvalidArgument, "upload %s has no partial file; restart the upload from offset 0", transferID))
		}
	}
	if err != nil {
		if isContainmentDenied(err) {
			return fail(err)
		}
		return fail(fmt.Errorf("failed to write file: %w", err))
	}

	written, werr := writeChunkAt(f, offset, data)
	if cerr := f.Close(); werr == nil && cerr != nil {
		werr = fmt.Errorf("failed to write file: %w", cerr)
	}
	if werr == nil && final {
		werr = verifyUploadHash(tempPath, totalSize, wantHash)
	}
	if werr != nil {
		if final || offset == 0 {
			_ = os.Remove(tempPath)
		}
		return fail(werr)
	}

	if !final {
		return NewSuccessResult(map[string]any{
			"path":     cleanPath,
			"received": end,
			"written":  written,
		}, time.Since(start).Milliseconds())
	}

	if info, serr := os.Lstat(cleanPath); serr == nil && info.IsDir() {
		_ = os.Remove(tempPath)
		return fail(errorCodef(wire.ErrCodePathIsDirectory, "path is a directory, not a file"))
	}
	// Re-check the destination right before the rename: the path-level gate
	// at the top ran before the (potentially long) upload.
	if err := enforceWriteContainment(cleanPath); err != nil {
		_ = os.Remove(tempPath)
		return fail(err)
	}
	afterPathCheck(cleanPath)
	if err := os.Rename(tempPath, cleanPath); err != nil {
		_ = os.Remove(tempPath)
		return fail(fmt.Errorf("failed to write file: %w", err))
	}

	return NewSuccessResult(map[string]any{
		"path":     cleanPath,
		"size":     totalSize,
		"written":  true,
		"complete": true,
		"sha256":   wantHash,
	}, time.Since(start).Milliseconds())
}

// writeChunkAt writes data at offset, which must be the temp file's current
// size. A replay of the chunk that ended the file (same offset, same length)
// is acknowledged without writing, so a retry after a lost reply is harmless.
func writeChunkAt(f *os.File, offset int, data []byte) (bool, error) {
	info, err := f.Stat()
	if err != nil {
		return false, fmt.Errorf("failed to write file: %w", err)
	}
	size := info.Size()
	if size != int64(offset) {
		if offset > 0 && size == int64(offset+len(data)) {
			existing := make([]byte, len(data))
			if _, rerr := f.ReadAt(existing, int64(offset)); rerr == nil && string(existing) == string(data) {
				return false, nil
			}
		}
		return false, errorCodef(wire.ErrCodeInvalidArgument, "chunk offset mismatch: partial file has %d bytes, chunk starts at %d", size, offset)
	}
	if _, err := f.WriteAt(data, int64(offset)); err != nil {
		return false, fmt.Errorf("failed to write file: %w", err)
	}
	return true, nil
}

func verifyUploadHash(tempPath string, totalSize int, wantHash string) error {
	f, err := os.Open(tempPath)
	if err != nil {
		return fmt.Errorf("failed to verify upload: %w", err)
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil {
		return fmt.Errorf("failed to verify upload: %w", err)
	}
	if info.Size() != int64(totalSize) {
		return errorCodef(wire.ErrCodeInvalidArgument, "upload incomplete: %d of %d bytes received", info.Size(), totalSize)
	}
	got, err := hashFile(f)
	if err != nil {
		return fmt.Errorf("failed to verify upload: %w", err)
	}
	if got != wantHash {
		return errorCodef(wire.ErrCodeInvalidArgument, "upload checksum mismatch: expected sha256 %s, got %s; the partial file was discarded", wantHash, got)
	}
	return nil
}

// openFileForRead resolves, gates and opens path for reading. The containment
// check, the stat and the read all use the returned handle, so the file that
// is checked is the file that is read. Shared by ReadFile and ReadFileChunk.
func openFileForRead(path string) (*os.File, string, os.FileInfo, error) {
	cleanPath := filepath.Clean(path)

	// Defense-in-depth: never read a credential store, even symlinked.
	if err := enforceReadContainment(cleanPath); err != nil {
		return nil, cleanPath, nil, err
	}

	// Downloading a macOS Finder alias should deliver the file it points at, not
	// the bookmark blob (issue #3344). Containment is re-checked against the
	// target because an alias can point anywhere, including at a credential
	// store that filepath.EvalSymlinks would never have surfaced.
	if target, ok := resolveMacAliasPath(cleanPath); ok {
		if err := enforceReadContainment(target); err != nil {
			return nil, cleanPath, nil, err
		}
		cleanPath = target
	}

	afterPathCheck(cleanPath)
	f, err := os.Open(cleanPath)
	if err != nil {
		return nil, cleanPath, nil, fmt.Errorf("failed to stat file: %w", err)
	}
	if err := checkOpenedForContainment("read", cleanPath, f); err != nil {
		_ = f.Close()
		return nil, cleanPath, nil, err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, cleanPath, nil, fmt.Errorf("failed to stat file: %w", err)
	}
	if info.IsDir() {
		_ = f.Close()
		return nil, cleanPath, nil, errorCodef(wire.ErrCodePathIsDirectory, "path is a directory, not a file")
	}
	return f, cleanPath, info, nil
}

// ReadFileChunk handles file_read_chunk.
func ReadFileChunk(payload map[string]any) CommandResult {
	start := time.Now()
	fail := func(err error) CommandResult { return NewErrorResult(err, time.Since(start).Milliseconds()) }

	path := GetPayloadString(payload, "path", "")
	if path == "" {
		return fail(errorCodef(wire.ErrCodeInvalidArgument, "path is required"))
	}
	offset, err := ParsePayloadInt(payload, "offset", 0)
	if err != nil || offset < 0 {
		return fail(errorCodef(wire.ErrCodeInvalidArgument, "offset must be >= 0"))
	}
	length, err := ParsePayloadInt(payload, "length", FileChunkMaxBytes)
	if err != nil || length <= 0 || length > FileChunkMaxBytes {
		return fail(errorCodef(wire.ErrCodeInvalidArgument, "length must be between 1 and %d", FileChunkMaxBytes))
	}

	f, cleanPath, info, err := openFileForRead(path)
	if err != nil {
		return fail(err)
	}
	defer func() { _ = f.Close() }()

	size := info.Size()
	if size > MaxChunkedTransferSize {
		return fail(errorCodef(wire.ErrCodeFileTooLarge, "file too large: %d bytes (max %d bytes)", size, MaxChunkedTransferSize))
	}
	if int64(offset) > size {
		return fail(errorCodef(wire.ErrCodeInvalidArgument, "offset %d is past the end of the file (%d bytes)", offset, size))
	}

	n := int64(length)
	if remaining := size - int64(offset); remaining < n {
		n = remaining
	}
	buf := make([]byte, n)
	read, err := f.ReadAt(buf, int64(offset))
	if err != nil && !errors.Is(err, io.EOF) {
		return fail(fmt.Errorf("failed to read file: %w", err))
	}
	buf = buf[:read]

	result := map[string]any{
		"path":     cleanPath,
		"size":     size,
		"offset":   offset,
		"length":   len(buf),
		"content":  base64.StdEncoding.EncodeToString(buf),
		"modified": info.ModTime().Format(time.RFC3339Nano),
		"eof":      int64(offset+len(buf)) >= size,
	}
	if GetPayloadBool(payload, "withHash", false) {
		sum, herr := hashFile(f)
		if herr != nil {
			return fail(fmt.Errorf("failed to read file: %w", herr))
		}
		result["sha256"] = sum
	}
	return NewSuccessResult(result, time.Since(start).Milliseconds())
}
