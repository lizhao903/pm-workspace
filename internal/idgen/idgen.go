// Package idgen 生成时间有序的短 ID（毫秒时间戳 + 随机位，base32 小写），零依赖且可排序。
package idgen

import (
	"crypto/rand"
	"encoding/binary"
	"strings"
	"time"
)

const alphabet = "0123456789abcdefghjkmnpqrstvwxyz"

// New 返回 16 字符的时间有序 ID。
func New() string {
	var buf [10]byte
	ms := uint64(time.Now().UnixMilli())
	buf[0] = byte(ms >> 40)
	buf[1] = byte(ms >> 32)
	buf[2] = byte(ms >> 24)
	buf[3] = byte(ms >> 16)
	buf[4] = byte(ms >> 8)
	buf[5] = byte(ms)
	var r [4]byte
	if _, err := rand.Read(r[:]); err != nil {
		binary.BigEndian.PutUint32(r[:], uint32(time.Now().UnixNano()))
	}
	copy(buf[6:], r[:])

	var sb strings.Builder
	sb.Grow(16)
	var acc, bits uint32
	for _, b := range buf {
		acc = acc<<8 | uint32(b)
		bits += 8
		for bits >= 5 {
			bits -= 5
			sb.WriteByte(alphabet[(acc>>bits)&31])
		}
	}
	if bits > 0 {
		sb.WriteByte(alphabet[(acc<<(5-bits))&31])
	}
	return sb.String()
}

// Prefixed 返回带前缀的 ID，如 obj_01j8x...。
func Prefixed(p string) string { return p + "_" + New() }
