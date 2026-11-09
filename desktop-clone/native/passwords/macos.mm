#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <LocalAuthentication/LocalAuthentication.h>
#include <cstdint>
#include <cstring>

static NSMutableDictionary* query(const char* target) {
  constexpr char prefix[] = "TinyGPT/BrowserPasswords/";
  if (!target || strlen(target) > 512 || strncmp(target, prefix, sizeof(prefix)-1) != 0) return nil;
  NSString* account = [NSString stringWithUTF8String:target]; if (!account) return nil;
  return [@{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecUseDataProtectionKeychain:@YES,
    (__bridge id)kSecAttrService:@"org.tinygpt.browser-passwords.v1", (__bridge id)kSecAttrAccount:account} mutableCopy];
}
extern "C" __attribute__((visibility("default"))) int tg_available() { return 1; }
extern "C" __attribute__((visibility("default"))) int tg_put(const char* target, const uint8_t* bytes, uint32_t size) {
  @autoreleasepool {
    auto item = query(target); if (!item || !bytes || !size || size > 2500) return 0;
    // Updates preserve the existing access control; never delete first.
    NSData* data = [NSData dataWithBytes:bytes length:size];
    OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)item, (__bridge CFDictionaryRef)@{(__bridge id)kSecValueData:data});
    if (status == errSecSuccess) return 1; if (status != errSecItemNotFound) return 0;
    CFErrorRef error = nullptr;
    auto access = SecAccessControlCreateWithFlags(nullptr, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, kSecAccessControlUserPresence, &error);
    if (!access) { if (error) CFRelease(error); return 0; }
    item[(__bridge id)kSecAttrAccessControl] = (__bridge id)access;
    item[(__bridge id)kSecValueData] = data;
    item[(__bridge id)kSecAttrSynchronizable] = @NO;
    status = SecItemAdd((__bridge CFDictionaryRef)item, nullptr); CFRelease(access); return status == errSecSuccess ? 1 : 0;
  }
}
extern "C" __attribute__((visibility("default"))) int tg_read(const char* target, const uint8_t*, uint8_t* bytes, uint32_t size) {
  @autoreleasepool {
    auto item = query(target); if (!item || !bytes) return 0;
    item[(__bridge id)kSecReturnData] = @YES;
    item[(__bridge id)kSecUseOperationPrompt] = @"Fill a saved TinyGPT browser password";
    LAContext* context = [[LAContext alloc] init];
    context.touchIDAuthenticationAllowableReuseDuration = 0;
    item[(__bridge id)kSecUseAuthenticationContext] = context;
    CFTypeRef result = nullptr; OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)item, &result);
    [context invalidate];
    if (status != errSecSuccess) { if (result) CFRelease(result); return status == errSecUserCanceled || status == errSecAuthFailed ? -2 : 0; }
    NSData* data = CFBridgingRelease(result); if (![data isKindOfClass:NSData.class] || data.length > size) return 0;
    memcpy(bytes, data.bytes, data.length); return static_cast<int>(data.length);
  }
}
extern "C" __attribute__((visibility("default"))) int tg_remove(const char* target) {
  @autoreleasepool { auto item = query(target); if (!item) return 0; auto status = SecItemDelete((__bridge CFDictionaryRef)item); return status == errSecSuccess || status == errSecItemNotFound ? 1 : 0; }
}
