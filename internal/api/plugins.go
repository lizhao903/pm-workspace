package api

import "net/http"

// pluginRoutes 把插件在启动时登记的路由挂进来。插件停用时同一路径回 404，
// 和不存在的接口一模一样，前端不用区分「没装」和「停用」。
// 插件路由一样要写进 docs/api-contract.md，契约测试按 routes() 收到的模式比对。
func (s *Server) pluginRoutes(m routeRegistrar) {
	if s.opt.Plugins == nil {
		return
	}
	notFound := func(w http.ResponseWriter, r *http.Request) {
		s.fail(w, r, notFoundf("no such endpoint: %s %s", r.Method, r.URL.Path))
	}
	for _, rt := range s.opt.Plugins.Routes(notFound) {
		m.HandleFunc(rt.Pattern, rt.Handler)
	}
}
