the DNS server your computer asked: 129.105.49.1
the IP address returned for google.com: 142.251.210.238
whether the answer says Non-authoritative answer: yes

shows full dns response while short only shows the answer
A: an A record maps a domain name to an IPv4 address
AAAA: an AAAA record maps a domain name to an IPv6 address
MX: An MX record identifies the mail server that receives email for a domain.
NS: An NS record lists the name servers responsible for a domain's DNS records.

Did both resolvers return the same address? no
If they returned different addresses, why might that still be normal? often use multiple different servers

it says my connection is not private when opening this. 

difference between dig and curl is that dig looks up DNS information while curl communicates with the web servers.

What does DNS do before HTTP starts? DNS translates a domain name into an IP address so the browser knows where to connect.
What is a DNS resolver? A DNS resolver is a server that looks up the IP address for a domain name.
Why is a raw IP address not the same as typing the domain name in the browser? A raw IP address may not match the website's security certificate or host configuration.
What did ChatGPT explain well? ChatGPT clearly explained how DNS records and lookups work.
What did you still need to verify by running commands yourself? I needed to verify the actual DNS records and responses on my own computer.