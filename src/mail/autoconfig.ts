// Mail client setup: the Thunderbird autoconfig file (also read by K-9, FairEmail and Evolution), Outlook's
// autodiscover answer, and an Apple configuration profile for iPhone, iPad and Mac Mail. They all point at the
// mail host with TLS, and sign in with the address and an app password.

import type { MailConfig } from "./config.ts";

const xml = (value: string) =>
  value.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function thunderbirdConfig(config: MailConfig, domain: string): string {
  const host = xml(config.hostname);
  return `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="${xml(domain)}">
    <domain>${xml(domain)}</domain>
    <displayName>${xml(domain)} (Richelieu)</displayName>
    <displayShortName>${xml(domain)}</displayShortName>
    <incomingServer type="imap">
      <hostname>${host}</hostname>
      <port>${config.ports.imaps}</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>${host}</hostname>
      <port>${config.ports.submissions}</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
    <outgoingServer type="smtp">
      <hostname>${host}</hostname>
      <port>${config.ports.submission}</port>
      <socketType>STARTTLS</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>
`;
}

export function autodiscoverResponse(
  config: MailConfig,
  email: string,
): string {
  const host = xml(config.hostname);
  return `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <Protocol>
        <Type>IMAP</Type>
        <Server>${host}</Server>
        <Port>${config.ports.imaps}</Port>
        <LoginName>${xml(email)}</LoginName>
        <SSL>on</SSL>
        <SPA>off</SPA>
        <AuthRequired>on</AuthRequired>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type>
        <Server>${host}</Server>
        <Port>${config.ports.submissions}</Port>
        <LoginName>${xml(email)}</LoginName>
        <SSL>on</SSL>
        <SPA>off</SPA>
        <AuthRequired>on</AuthRequired>
      </Protocol>
    </Account>
  </Response>
</Autodiscover>
`;
}

/** An unsigned .mobileconfig with one mail account; the device asks for the password when it is left out. */
export function appleProfile(
  config: MailConfig,
  account: { address: string; displayName: string },
  password?: string,
): string {
  const id = crypto.randomUUID().toUpperCase();
  const payload = crypto.randomUUID().toUpperCase();
  const host = xml(config.hostname);
  const address = xml(account.address);
  const name = xml(account.displayName || account.address);
  const secret = password
    ? `<key>IncomingPassword</key><string>${xml(password)}</string><key>OutgoingPassword</key><string>${xml(password)}</string>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>EmailAccountDescription</key><string>${address}</string>
      <key>EmailAccountName</key><string>${name}</string>
      <key>EmailAccountType</key><string>EmailTypeIMAP</string>
      <key>EmailAddress</key><string>${address}</string>
      <key>IncomingMailServerAuthentication</key><string>EmailAuthPassword</string>
      <key>IncomingMailServerHostName</key><string>${host}</string>
      <key>IncomingMailServerPortNumber</key><integer>${config.ports.imaps}</integer>
      <key>IncomingMailServerUseSSL</key><true/>
      <key>IncomingMailServerUsername</key><string>${address}</string>
      <key>OutgoingMailServerAuthentication</key><string>EmailAuthPassword</string>
      <key>OutgoingMailServerHostName</key><string>${host}</string>
      <key>OutgoingMailServerPortNumber</key><integer>${config.ports.submissions}</integer>
      <key>OutgoingMailServerUseSSL</key><true/>
      <key>OutgoingMailServerUsername</key><string>${address}</string>
      <key>OutgoingPasswordSameAsIncomingPassword</key><true/>
      ${secret}
      <key>PayloadDisplayName</key><string>${address}</string>
      <key>PayloadIdentifier</key><string>ai.richelieu.mail.${payload}</string>
      <key>PayloadType</key><string>com.apple.mail.managed</string>
      <key>PayloadUUID</key><string>${payload}</string>
      <key>PayloadVersion</key><integer>1</integer>
    </dict>
  </array>
  <key>PayloadDisplayName</key><string>Mail for ${address}</string>
  <key>PayloadIdentifier</key><string>ai.richelieu.mail.profile.${id}</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${id}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>
`;
}
