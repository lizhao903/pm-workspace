package api

import (
	"net/http"

	"github.com/lizhao903/pm-workspace/internal/selfupdate"
)

// handleUpdateStatus 设置页「版本更新」（SYS-UPD）：正在跑的版本、源码目录比它新多少、能不能更新、最近一次更新的进度。
// 这个实例没接更新器（测试里、不是从二进制跑起来的）时 blocked 说明原因
func (s *Server) handleUpdateStatus(w http.ResponseWriter, r *http.Request) {
	if s.opt.Updater == nil {
		respondData(w, http.StatusOK, selfupdate.Status{
			Running: selfupdate.RunningBuild(s.opt.Version, ""),
			Blocked: "这个实例不支持就地更新",
		})
		return
	}
	respondData(w, http.StatusOK, s.opt.Updater.Status(r.Context()))
}

// handleStartUpdate 开始一次更新：备份库、构建前端、构建后端和 MCP 到 .new、自检、替换并原地重启。
// 马上回 202 和当前状态，进度轮询 GET；已经在更新回 409，不能更新回 409 带原因
func (s *Server) handleStartUpdate(w http.ResponseWriter, r *http.Request) {
	u := s.opt.Updater
	if u == nil {
		s.fail(w, r, conflictf("这个实例不支持就地更新"))
		return
	}
	if st := u.Status(r.Context()); st.Blocked != "" {
		s.fail(w, r, conflictf("%s", st.Blocked))
		return
	}
	if err := u.Start(); err != nil {
		s.fail(w, r, conflictf("%v", err))
		return
	}
	s.auditConfig(r, "update", "system", "update", "开始更新到源码目录里的最新版本", nil)
	respondData(w, http.StatusAccepted, u.Status(r.Context()))
}
