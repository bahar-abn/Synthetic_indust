#!/bin/bash

cd /Users/bahar/Downloads/synthetic_indust

echo "=========================================="
echo "FINAL STATUS CHECK"
echo "=========================================="

echo ""
echo "📊 MODELS BY CLASS:"
echo "-------------------"
for class in Compressor Crane ElectroMotor FanSanati FireTruck Hydrant KapsoleAtashNeshani PanelBargh ShirAtashNeshani; do
    if [ -d "public/models/$class" ]; then
        total=$(find public/models/$class -type f \( -name "*.fbx" -o -name "*.obj" -o -name "*.glb" -o -name "*.gltf" \) 2>/dev/null | wc -l | tr -d ' ')
        glb=$(find public/models/$class -name "*.glb" 2>/dev/null | wc -l | tr -d ' ')
        other=$(find public/models/$class -type f \( -name "*.fbx" -o -name "*.obj" -o -name "*.gltf" \) 2>/dev/null | wc -l | tr -d ' ')
        echo "$class: $glb GLB, $other other, $total total"
    fi
done

echo ""
echo "🔍 REMAINING FBX/OBJ/GLTF FILES:"
echo "--------------------------------"
find public/models -type f \( -name "*.fbx" -o -name "*.obj" -o -name "*.gltf" \) | while read file; do
    glb_file="${file%.*}.glb"
    if [ -f "$glb_file" ]; then
        echo "✅ $file -> has GLB"
    else
        echo "❌ $file -> NO GLB!"
    fi
done | grep "NO GLB"

echo ""
echo "📦 UNUSED GLB FILES IN models_processed:"
echo "-----------------------------------------"
find public/models_processed -name "*.glb" | while read file; do
    basename_file=$(basename "$file")
    found=$(find public/models -name "$basename_file" 2>/dev/null | head -1)
    if [ -z "$found" ]; then
        echo "⚠️ $file -> not used"
    fi
done

echo ""
echo "=========================================="
echo "NEXT STEPS:"
echo "=========================================="
echo "1. Run: npm run discover"
echo "2. Run: npm run generate (test with 1 image)"
echo "3. Check if models render correctly"
