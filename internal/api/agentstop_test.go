package api

import (
	"context"
	"testing"
)

// 停止：按会话停掉在跑的轮次，停的原因能认出是手动；结束后从列表里拿掉。
func TestActiveTurnsStop(t *testing.T) {
	var a activeTurns
	ctx1, done1 := a.start(context.Background(), "ags_a")
	ctx2, done2 := a.start(context.Background(), "ags_a")
	ctx3, done3 := a.start(context.Background(), "ags_b")
	defer done3()
	if got := a.list(); len(got) != 2 || got[0] != "ags_a" || got[1] != "ags_b" {
		t.Fatalf("在跑的会话 = %v", got)
	}
	if n := a.stop("ags_a"); n != 2 {
		t.Fatalf("停了 %d 轮，期望 2", n)
	}
	for _, c := range []context.Context{ctx1, ctx2} {
		if c.Err() == nil || !stoppedByUser(c) {
			t.Fatalf("ags_a 的轮次应被手动停止：err=%v", c.Err())
		}
	}
	if ctx3.Err() != nil {
		t.Fatal("别的会话不该被停")
	}
	done1()
	done2()
	if got := a.list(); len(got) != 1 || got[0] != "ags_b" {
		t.Fatalf("结束后列表 = %v", got)
	}
	if n := a.stop("ags_none"); n != 0 {
		t.Fatalf("没在跑的会话停了 %d 轮", n)
	}
	// 正常结束（done）不算手动停止
	ctx4, done4 := a.start(context.Background(), "ags_c")
	done4()
	if stoppedByUser(ctx4) {
		t.Fatal("正常结束不该算手动停止")
	}
}
