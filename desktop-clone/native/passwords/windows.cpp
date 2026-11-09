#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincred.h>
#include <UserConsentVerifierInterop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Security.Credentials.UI.h>
#include <string>
#include <cstdint>
#include <cstring>

using namespace winrt;
using namespace Windows::Security::Credentials::UI;
static std::wstring wide(const char* text) {
  if (!text || strlen(text) > 512) throw 1;
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1, nullptr, 0);
  if (!size) throw 1;
  std::wstring result(size, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1, result.data(), size);
  result.resize(size-1); return result;
}
static std::wstring target(const char* text) {
  auto name = wide(text);
  if (name.rfind(L"TinyGPT/BrowserPasswords/", 0) != 0) throw 1;
  return name;
}
struct Apartment { Apartment() { init_apartment(apartment_type::multi_threaded); } ~Apartment() { uninit_apartment(); } };
extern "C" __declspec(dllexport) int tg_available() {
  try {
    Apartment apartment;
    auto interop = get_activation_factory<UserConsentVerifier, IUserConsentVerifierInterop>();
    const auto status = UserConsentVerifier::CheckAvailabilityAsync().get();
    return status == UserConsentVerifierAvailability::Available ? 1 : -10-static_cast<int>(status);
  } catch (...) { return 0; }
}
extern "C" __declspec(dllexport) int tg_put(const char* name, const uint8_t* bytes, uint32_t size) {
  try {
    auto key = target(name); if (!bytes || !size || size > CRED_MAX_CREDENTIAL_BLOB_SIZE) return 0;
    CREDENTIALW credential{}; credential.Type = CRED_TYPE_GENERIC; credential.TargetName = key.data();
    credential.CredentialBlobSize = size; credential.CredentialBlob = const_cast<BYTE*>(bytes);
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE; credential.UserName = const_cast<LPWSTR>(L"TinyGPT browser sign-in");
    return CredWriteW(&credential, 0) ? 1 : 0;
  } catch (...) { return 0; }
}
extern "C" __declspec(dllexport) int tg_read(const char* name, const uint8_t* handle, uint8_t* bytes, uint32_t size) {
  try {
    auto key = target(name); if (!handle || !bytes || !size) return 0;
    HWND owner{}; memcpy(&owner, handle, sizeof(owner)); if (!IsWindow(owner)) return 0;
    Apartment apartment;
    auto interop = get_activation_factory<UserConsentVerifier, IUserConsentVerifierInterop>();
    Windows::Foundation::IAsyncOperation<UserConsentVerificationResult> operation{nullptr};
    hstring prompt(L"Fill a saved TinyGPT browser password");
    check_hresult(interop->RequestVerificationForWindowAsync(owner, static_cast<HSTRING>(get_abi(prompt)), guid_of<decltype(operation)>(), put_abi(operation)));
    if (operation.get() != UserConsentVerificationResult::Verified) return -2;
    // Hello is a user-presence gate. Credential Manager remains protected by the
    // Windows account, not a Hello-bound cryptographic vault against same-user apps.
    PCREDENTIALW credential = nullptr; if (!CredReadW(key.c_str(), CRED_TYPE_GENERIC, 0, &credential)) return 0;
    const auto length = credential->CredentialBlobSize;
    if (length > size) { SecureZeroMemory(credential->CredentialBlob, length); CredFree(credential); return 0; }
    memcpy(bytes, credential->CredentialBlob, length);
    SecureZeroMemory(credential->CredentialBlob, length); CredFree(credential); return static_cast<int>(length);
  } catch (...) { return 0; }
}
extern "C" __declspec(dllexport) int tg_remove(const char* name) {
  try { auto key = target(name); return CredDeleteW(key.c_str(), CRED_TYPE_GENERIC, 0) || GetLastError() == ERROR_NOT_FOUND ? 1 : 0; } catch (...) { return 0; }
}
