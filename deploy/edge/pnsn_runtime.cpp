// Small C ABI over the board's installed BMRuntime; no vendor code is vendored.
#include <bmlib_runtime.h>
#include <bmruntime_interface.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <stdexcept>
#include <mutex>

struct Context {
  bm_handle_t handle = nullptr;
  void* runtime = nullptr;
  std::string network;
  bm_shape_t input{}, output{};
  std::mutex lock;
  ~Context() { if(runtime) bmrt_destroy(runtime); if(handle) bm_dev_free(handle); }
};
static thread_local std::string error;
extern "C" {
const char* sx_error() { return error.c_str(); }
void* sx_open(const char* path, int device) {
  Context* c = new Context();
  try {
    if(bm_dev_request(&c->handle, device) != BM_SUCCESS) throw std::runtime_error("Cannot open BM1684X");
    c->runtime = bmrt_create(c->handle);
    if(!c->runtime || !bmrt_load_bmodel(c->runtime, path)) throw std::runtime_error("Cannot load PNSN bmodel");
    const char** names = nullptr; bmrt_get_network_names(c->runtime, &names);
    if(!names || bmrt_get_network_number(c->runtime) != 1) throw std::runtime_error("Expected one PNSN graph");
    c->network = names[0]; free(names);
    const auto* info = bmrt_get_network_info(c->runtime, c->network.c_str());
    if(info->input_num != 1 || info->output_num != 1 || info->input_dtypes[0] != BM_FLOAT32 || info->output_dtypes[0] != BM_FLOAT32)
      throw std::runtime_error("PNSN requires F32 host input/output");
    c->input = info->stages[0].input_shapes[0]; c->output = info->stages[0].output_shapes[0];
    if(c->input.num_dims != 3 || c->input.dims[0] < 1 || c->input.dims[0] > 64 || c->input.dims[1] != 3 || c->input.dims[2] != 10240 || c->output.num_dims != 3 || c->output.dims[0] != c->input.dims[0] || c->output.dims[1] != 5 || c->output.dims[2] != 10240)
      throw std::runtime_error("Unexpected PNSN tensor contract");
    return c;
  } catch(const std::exception& e) { error=e.what(); delete c; return nullptr; }
}
int sx_batch(void* ctx) { return static_cast<Context*>(ctx)->input.dims[0]; }
int sx_infer(void* ctx, float* input, float* output) {
  auto* c=static_cast<Context*>(ctx); std::lock_guard<std::mutex> guard(c->lock);
  void* ins[]={input}; void* outs[]={output}; bm_shape_t result{};
  if(!bmrt_launch_data(c->runtime, c->network.c_str(), ins, &c->input, 1, outs, &result, 1, true)) { error="NPU inference failed"; return -1; }
  if(bmrt_shape_count(&result) != bmrt_shape_count(&c->output)) { error="NPU output shape changed"; return -2; }
  return 0;
}
void sx_close(void* ctx) { delete static_cast<Context*>(ctx); }
}
