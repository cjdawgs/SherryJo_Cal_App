r"""
Smart Project Setup + Structure Export

What this does:
✅ Scans your project
✅ Creates missing files based on rules
✅ Writes FULL structure to project_structure.json
✅ Safe to run repeatedly

Usage:  {Run this from /scripts subfolder:}
    python smart_setup.py "YOUR_PROJECT_PATH"
    
Workflow:

        #Run: python scripts\smart_setup.py "C:\Users\e201503110\OneDrive - Gwinnett County Public Schools\Desktop\Python\Chips Home Stuff\SherryJo Calendar App\Python Code\SherryJo_Cal_App"

        #Open: ... "\scripts\project_structure.json"  {this is providing the full project structure in JSON format}

        #Copy → paste {json} into Copilot prompt "\scripts\Copilot Prompt.txt"
    
This is the Copilot Prompt to use for subsequent Project Updates:
PROJECT CONTEXT:
    Existing FastAPI app. Do NOT break anything.

PROJECT STRUCTURE:
    [paste JSON here]

CURRENT PHASE:
    Phase 2 - Outlook OAuth

TASK:
    Implement OAuth login

OUTPUT:
    oauth.py    
    
"""

import os
import json
import sys

# ==========================================
# MODULE RULES
# ==========================================
MODULE_RULES = {
    "auth": ["oauth.py", "token_handler.py"],
    "services": ["graph_client.py", "calendar_service.py", "task_service.py"],
    "routes": ["auth_routes.py", "calendar_routes.py", "task_routes.py"],
    "models": ["event_model.py", "task_model.py"],
    "config": ["settings.py"],
}


# ==========================================
# Get Base Path
# ==========================================
def get_base_path():
    # If path passed in → use it
    if len(sys.argv) > 1:
        return sys.argv[1]

    # Otherwise use parent folder of /scripts
    current_dir = os.path.dirname(os.path.abspath(__file__))
    base_path = os.path.dirname(current_dir)

    return base_path


# ==========================================
# Scan Project Structure
# ==========================================
def scan_project(base_path):
    structure = {}

    EXCLUDE_DIRS = {
        '.git',
        '.venv',
        '.pytest_cache',
        '__pycache__',
        'Archive'
    }
    
    
    EXCLUDE_FILES = {'.pyc', '.log'}

    for root, dirs, files in os.walk(base_path):
        # ✅ Exclude unwanted directories (case-insensitive)
        dirs[:] = [d for d in dirs if d.lower() not in {e.lower() for e in EXCLUDE_DIRS}]
        
        files = [f for f in files if not any(f.endswith(ext) for ext in EXCLUDE_FILES)]

        rel_path = os.path.relpath(root, base_path)

        if rel_path == ".":
            rel_path = ""

        structure[rel_path] = files

    return structure

# ==========================================
# Enforce Structure
# ==========================================
def enforce_structure(base_path):
    print("\n🔧 Ensuring required structure...\n")

    for folder, expected_files in MODULE_RULES.items():
        folder_path = os.path.join(base_path, "app", folder)

        os.makedirs(folder_path, exist_ok=True)

        for file in expected_files:
            file_path = os.path.join(folder_path, file)

            if not os.path.exists(file_path):
                with open(file_path, "w") as f:
                    f.write(f"# Auto-generated: {file}\n")

                print(f"✅ Created: app/{folder}/{file}")
            else:
                print(f"✔ Exists: app/{folder}/{file}")


# ==========================================
# Save JSON INTO scripts folder
# ==========================================
def save_structure_json(structure):
    script_dir = os.path.dirname(os.path.abspath(__file__))
    output_file = os.path.join(script_dir, "project_structure.json")

    with open(output_file, "w") as f:
        json.dump(structure, f, indent=4)

    print(f"\n📦 Structure saved to: {output_file}")


# ==========================================
# MAIN
# ==========================================
def main():
    base_path = get_base_path()

    if not os.path.exists(base_path):
        print("❌ Invalid base path")
        return

    print(f"\n📁 Base Path: {base_path}")

    enforce_structure(base_path)

    structure = scan_project(base_path)

    save_structure_json(structure)


if __name__ == "__main__":
    main()
