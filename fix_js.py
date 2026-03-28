import subprocess

def check_js():
    with open('/Users/aranayabsarkar/experiments/crypto_terminal/testcrypto.html') as f:
        text = f.read()

    start = text.find('<script>') + 8
    end = text.rfind('</script>')
    jscode = text[start:end]

    with open('/tmp/test_script.js', 'w') as f:
        f.write(jscode)

    result = subprocess.run(['node', '-c', '/tmp/test_script.js'], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        print("Error:")
        print(result.stderr)
        return False
    else:
        print("Success!")
        return True

if __name__ == '__main__':
    check_js()
