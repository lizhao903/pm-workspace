package vault

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// KeyFileName 是退回方案下主密钥文件的名字，放在数据目录（pm.db 同级）。
const KeyFileName = "vault.key"

// keychainService 是钥匙串条目的服务名；账户名用数据目录的绝对路径，
// 不同数据目录（真实库、测试实例）各有各的主密钥。
const keychainService = "pm-workspace-vault"

const keyLen = 32 // AES-256

// KeySource 说明主密钥从哪来，只用于日志和启动提示。
type KeySource string

const (
	SourceKeychain KeySource = "keychain"
	SourceFile     KeySource = "file"
)

// KeyOptions 决定主密钥的存放方式。
// UseKeychain 为 false 时只用密钥文件：测试实例和自动化测试一律这样，免得弹系统授权框。
type KeyOptions struct {
	UseKeychain bool
}

// LoadMasterKey 取主密钥，没有就生成一把。顺序：
//  1. 钥匙串里已有 -> 用它
//  2. 数据目录下已有密钥文件 -> 用它（钥匙串不可用时生成的那把，不能因为钥匙串恢复了就换掉）
//  3. 钥匙串可写 -> 生成并存进钥匙串
//  4. 生成并写密钥文件（0600）
//
// 已有的密钥优先于新建，避免一次钥匙串抽风就换掉主密钥、让库里的密文全部解不开。
func LoadMasterKey(dataDir string, opt KeyOptions) ([]byte, KeySource, error) {
	abs, err := filepath.Abs(dataDir)
	if err != nil {
		return nil, "", fmt.Errorf("resolve data dir: %w", err)
	}
	kc := opt.UseKeychain && runtime.GOOS == "darwin"
	if kc {
		if key, err := keychainRead(abs); err == nil {
			return key, SourceKeychain, nil
		}
	}
	path := filepath.Join(abs, KeyFileName)
	key, err := readKeyFile(path)
	if err == nil {
		return key, SourceFile, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, "", err
	}

	key = make([]byte, keyLen)
	if _, err := rand.Read(key); err != nil {
		return nil, "", fmt.Errorf("generate master key: %w", err)
	}
	if kc {
		if err := keychainWrite(abs, key); err == nil {
			// 写完读回一次，确认以后真能取到，取不到就别用钥匙串。
			if got, err := keychainRead(abs); err == nil && bytes.Equal(got, key) {
				return key, SourceKeychain, nil
			}
		}
	}
	if err := writeKeyFile(path, key); err != nil {
		return nil, "", err
	}
	return key, SourceFile, nil
}

// KeyID 是主密钥的指纹，存进每一行，主密钥换了时能报清楚原因。
func KeyID(key []byte) string {
	sum := sha256.Sum256(key)
	return hex.EncodeToString(sum[:8])
}

func readKeyFile(path string) ([]byte, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	// 和 ssh 私钥一样：权限放宽了就拒绝，而不是悄悄继续用。
	if fi.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("vault key file %s has permissions %o, must be 0600 (run: chmod 600 %s)",
			path, fi.Mode().Perm(), path)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read vault key file: %w", err)
	}
	return decodeKey(raw)
}

// writeKeyFile 用 O_EXCL 建文件：两个进程同时首启时只有一个能写成功，
// 另一个读回对方写的那把，不会各拿一把。
func writeKeyFile(path string, key []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create data dir: %w", err)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			got, rerr := readKeyFile(path)
			if rerr != nil {
				return rerr
			}
			copy(key, got)
			return nil
		}
		return fmt.Errorf("create vault key file: %w", err)
	}
	_, werr := f.WriteString(base64.StdEncoding.EncodeToString(key) + "\n")
	cerr := f.Close()
	if werr != nil {
		return fmt.Errorf("write vault key file: %w", werr)
	}
	if cerr != nil {
		return fmt.Errorf("close vault key file: %w", cerr)
	}
	return nil
}

func decodeKey(raw []byte) ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || len(key) != keyLen {
		return nil, errors.New("vault master key is malformed (expect base64 of 32 bytes)")
	}
	return key, nil
}

// --- macOS 钥匙串，走 security 命令 ---

func keychainRead(account string) ([]byte, error) {
	out, err := exec.Command("security", "find-generic-password",
		"-s", keychainService, "-a", account, "-w").Output()
	if err != nil {
		return nil, err
	}
	return decodeKey(out)
}

// keychainWrite 的密钥会短暂出现在 security 的命令行参数里（本机 ps 可见）。
// security 不支持从 stdin 读非交互的口令，这是用钥匙串的代价；只在首次生成时发生一次。
func keychainWrite(account string, key []byte) error {
	return exec.Command("security", "add-generic-password",
		"-s", keychainService, "-a", account,
		"-l", "pm-workspace vault master key",
		"-w", base64.StdEncoding.EncodeToString(key)).Run()
}
